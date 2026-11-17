/**
 * Capture engine (runs in the offscreen document).
 *
 * tab stream (tabCapture, authorized by the editor's click)
 *   → audio back to the speakers (capturing would otherwise mute the tab)
 *   → MediaStreamTrackProcessor → VideoEncoder (H.264, keyframe every 2 s) / AudioEncoder (AAC or Opus)
 *   → ChunkRing (last ~2 minutes, in memory)
 *   → per second: loudness + motion/brightness → LiveSignals → capture-detected moments
 *   → clip requests (detected here, from chat, or "save last 30 s") → MP4 → IndexedDB
 *
 * Nothing leaves the browser.
 */
import { calculateScore } from "@/detection/analyzer";
import { createHighlight } from "@/local/highlights";
import { saveClip } from "@/local/clips";
import { LoudnessMeter } from "@/offscreen/loudness";
import type { CaptureOptions, CaptureTarget, ClipRequest } from "@/types/capture";
import { ChunkRing } from "./buffer";
import { muxMp4, type TrackConfigs } from "./mux";
import { LiveSignals } from "./signals";

const KEYFRAME_MS = 2000;
const SAMPLE_MS = 250; // motion sampling
const COOLDOWN_MS = 30_000;
const VIDEO_CODECS = ["avc1.640028", "avc1.4d4028", "avc1.4d401f", "avc1.42001f"];

export interface EngineEvents {
  status: (s: { bufferedSeconds: number; levelDb: number | null }) => void;
  clipSaved: (c: { clipId: number; highlightId: number; durationSec: number }) => void;
  clipFailed: (c: { highlightId: number; reason: string }) => void;
  ended: (reason: string) => void;
}

interface Processor<T> {
  readable: ReadableStream<T>;
}
declare const MediaStreamTrackProcessor: { new <T>(init: { track: MediaStreamTrack }): Processor<T> };

async function pickVideoCodec(width: number, height: number): Promise<VideoEncoderConfig> {
  for (const codec of VIDEO_CODECS) {
    const cfg: VideoEncoderConfig = { codec, width, height, bitrate: 3_000_000, framerate: 30, latencyMode: "realtime", avc: { format: "avc" } };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
  }
  throw new Error("This browser can't encode H.264 video (WebCodecs).");
}

async function pickAudioCodec(sampleRate: number, numberOfChannels: number): Promise<{ cfg: AudioEncoderConfig; codec: "aac" | "opus" } | null> {
  for (const [codec, name] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const cfg: AudioEncoderConfig = { codec, sampleRate, numberOfChannels, bitrate: 128_000 };
    if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, codec: name };
  }
  return null;
}

/** Counters for diagnosing a capture (read from the offscreen document's console). */
export const captureStats = { videoFrames: 0, videoChunks: 0, audioFrames: 0, audioChunks: 0, errors: [] as string[] };
(globalThis as { __streamhunterCapture?: typeof captureStats }).__streamhunterCapture = captureStats;

export async function startEngine(streamId: string, target: CaptureTarget, opts: CaptureOptions, on: EngineEvents) {
  const mandatory = { chromeMediaSource: "tab", chromeMediaSourceId: streamId };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory } as unknown as MediaTrackConstraints,
    video: { mandatory: { ...mandatory, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 } } as unknown as MediaTrackConstraints,
  });
  const [vTrack] = stream.getVideoTracks();
  const [aTrack] = stream.getAudioTracks();
  if (!vTrack) throw new Error("The tab has no video to capture.");

  // Keep the tab audible.
  const ctx = new AudioContext();
  if (aTrack) ctx.createMediaStreamSource(new MediaStream([aTrack])).connect(ctx.destination);

  const settings = vTrack.getSettings();
  const width = Math.max(2, Math.floor((settings.width ?? 1280) / 2) * 2);
  const height = Math.max(2, Math.floor((settings.height ?? 720) / 2) * 2);
  const vCfg = await pickVideoCodec(width, height);
  const ring = new ChunkRing(opts.bufferSeconds * 1000);
  const signals = new LiveSignals();
  const meter = new LoudnessMeter();
  const configs: TrackConfigs = { video: { width, height, decoderConfig: { codec: vCfg.codec, codedWidth: width, codedHeight: height } }, audio: null };
  const pending: ClipRequest[] = [];
  let stopped = false;
  let lastMoment = 0;

  // --- video -----------------------------------------------------------------------------------
  let vBase: { wall: number; ts: number } | null = null;
  const vAt = (ts: number) => (vBase ? vBase.wall + (ts - vBase.ts) / 1000 : Date.now());
  const vEnc = new VideoEncoder({
    output: (chunk, meta) => {
      captureStats.videoChunks += 1;
      if (meta?.decoderConfig) configs.video.decoderConfig = meta.decoderConfig;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      ring.push({ kind: "video", key: chunk.type === "key", at: vAt(chunk.timestamp), duration: (chunk.duration ?? 33_333) / 1000, data });
    },
    error: (e) => {
      captureStats.errors.push(`video: ${e.message}`);
      void stop(`Video encoding failed: ${e.message}`);
    },
  });
  vEnc.configure(vCfg);

  const canvas = new OffscreenCanvas(64, 36);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  let prevLuma: Float32Array | null = null;
  let lastSample = 0;
  let lastKey = 0;
  let secMotion: number[] = [];
  let secBright: number[] = [];

  function sample(frame: VideoFrame) {
    g.drawImage(frame, 0, 0, 64, 36);
    const px = g.getImageData(0, 0, 64, 36).data;
    const luma = new Float32Array(64 * 36);
    let sum = 0;
    for (let i = 0; i < luma.length; i++) {
      const y = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
      luma[i] = y;
      sum += y;
    }
    secBright.push(sum / luma.length);
    if (prevLuma) {
      let d = 0;
      for (let i = 0; i < luma.length; i++) d += Math.abs(luma[i]! - prevLuma[i]!);
      secMotion.push(d / luma.length);
    }
    prevLuma = luma;
  }

  void (async () => {
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track: vTrack }).readable.getReader();
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      captureStats.videoFrames += 1;
      if (!vBase) vBase = { wall: Date.now(), ts: frame.timestamp };
      const at = vAt(frame.timestamp);
      if (at - lastSample >= SAMPLE_MS) {
        lastSample = at;
        try {
          sample(frame);
        } catch {
          /* a frame that can't be drawn is skipped */
        }
      }
      if (vEnc.state === "configured" && vEnc.encodeQueueSize < 8) {
        const keyFrame = at - lastKey >= KEYFRAME_MS;
        if (keyFrame) lastKey = at;
        vEnc.encode(frame, { keyFrame });
      }
      frame.close();
    }
  })().catch((e: unknown) => captureStats.errors.push(`video reader: ${e instanceof Error ? e.message : String(e)}`));

  // --- audio -----------------------------------------------------------------------------------
  let aEnc: AudioEncoder | null = null;
  if (aTrack) {
    const as = aTrack.getSettings();
    const picked = await pickAudioCodec(as.sampleRate ?? 48_000, Math.min(2, as.channelCount ?? 2));
    if (picked) {
      let aBase: { wall: number; ts: number } | null = null;
      const aAt = (ts: number) => (aBase ? aBase.wall + (ts - aBase.ts) / 1000 : Date.now());
      configs.audio = { codec: picked.codec, sampleRate: picked.cfg.sampleRate, numberOfChannels: picked.cfg.numberOfChannels, decoderConfig: { codec: picked.cfg.codec, sampleRate: picked.cfg.sampleRate, numberOfChannels: picked.cfg.numberOfChannels } };
      aEnc = new AudioEncoder({
        output: (chunk, meta) => {
          captureStats.audioChunks += 1;
          if (meta?.decoderConfig && configs.audio) configs.audio.decoderConfig = meta.decoderConfig;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          ring.push({ kind: "audio", key: true, at: aAt(chunk.timestamp), duration: (chunk.duration ?? 21_333) / 1000, data });
        },
        error: (e) => void captureStats.errors.push(`audio: ${e.message}`), // video-only clips are still useful
      });
      aEnc.configure(picked.cfg);
      const enc = aEnc;
      void (async () => {
        const reader = new MediaStreamTrackProcessor<AudioData>({ track: aTrack }).readable.getReader();
        const plane = new Float32Array(8192);
        while (!stopped) {
          const { value: audio, done } = await reader.read();
          if (done || !audio) break;
          captureStats.audioFrames += 1;
          if (!aBase) aBase = { wall: Date.now(), ts: audio.timestamp };
          try {
            const n = Math.min(audio.numberOfFrames, plane.length);
            audio.copyTo(plane.subarray(0, n), { planeIndex: 0, format: "f32-planar", frameCount: n });
            meter.add(plane.subarray(0, n));
          } catch {
            /* loudness is best effort */
          }
          if (enc.state === "configured") enc.encode(audio);
          audio.close();
        }
      })().catch((e: unknown) => captureStats.errors.push(`audio reader: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // --- once a second: signals, detection, due clips ----------------------------------------------
  async function cut(req: ClipRequest) {
    const sel = ring.select(req.start, req.end);
    if (!sel) {
      on.clipFailed({ highlightId: req.highlightId, reason: "That moment is no longer in the capture buffer." });
      return;
    }
    const blob = muxMp4(sel.video, sel.audio, configs);
    const clip = await saveClip({
      candidateId: req.highlightId, sessionId: target.sessionId, streamerId: target.streamerId, streamerName: target.displayName,
      platform: target.platform, title: req.title, startedAt: sel.from, durationSec: (sel.to - sel.from) / 1000, width, height,
      score: req.score, blob,
    });
    on.clipSaved({ clipId: clip.id, highlightId: req.highlightId, durationSec: (sel.to - sel.from) / 1000 });
  }

  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const level = meter.take(new Date(now));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const sorted = [...secMotion].sort((a, b) => a - b);
    signals.add({
      t: now,
      db: level?.db ?? null,
      motion: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null, // median: one hard cut isn't action
      brightness: secBright.length ? Math.max(...secBright) : avg(secBright),
    });
    secMotion = [];
    secBright = [];

    const m = now - lastMoment > COOLDOWN_MS ? signals.detect(now) : null;
    if (m) {
      const score = Math.round(calculateScore({ audio: m.audio, visual: m.visual }));
      if (score >= opts.minScore) {
        lastMoment = now;
        const start = now - opts.preRollSeconds * 1000;
        const end = now + opts.postRollSeconds * 1000;
        void createHighlight({
          streamer: { id: target.streamerId, display_name: target.displayName, username: target.username, platform: target.platform },
          session: target.sessionId ? { id: target.sessionId, broadcast_started_at: target.broadcastStartedAt } : null,
          origin: "capture", peakAt: now, startAt: start, endAt: end, score, confidence: 0.6,
          category: m.reasons.some((r) => r.startsWith("Fast") || r.startsWith("Sudden")) ? "gameplay_highlight" : "exciting_moment",
          reasons: m.reasons,
          breakdown: { chat: null, audio: m.audio, visual: m.visual, context: null, active_signals: ["audio", "visual"].filter((k) => (k === "audio" ? m.audio : m.visual) !== null), audio_source: "capture" },
        }).then((h) => pending.push({ highlightId: h.id, start, end, title: `${target.displayName} · ${m.reasons[0]}`, score }));
      }
    }

    for (const req of [...pending]) {
      if ((ring.newest ?? 0) >= req.end || now > req.end + 5000) {
        pending.splice(pending.indexOf(req), 1);
        void cut(req).catch((e: unknown) => on.clipFailed({ highlightId: req.highlightId, reason: e instanceof Error ? e.message : "Clip failed" }));
      }
    }
    if (++ticks % 3 === 0) on.status({ bufferedSeconds: Math.round(((ring.newest ?? now) - (ring.oldest ?? now)) / 1000), levelDb: level?.db ?? null });
  }, 1000);

  vTrack.addEventListener("ended", () => void stop("The tab was closed or stopped sharing."));

  async function stop(reason = "Stopped") {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // Moments still waiting for their post-roll: cut what we have.
    for (const req of pending.splice(0)) await cut(req).catch(() => undefined);
    stream.getTracks().forEach((t) => t.stop());
    for (const enc of [vEnc, aEnc]) if (enc && enc.state !== "closed") enc.close();
    void ctx.close();
    on.ended(reason);
  }

  return {
    requestClip(req: ClipRequest) {
      pending.push(req);
    },
    stop,
    get bufferedSeconds() {
      return Math.round(((ring.newest ?? 0) - (ring.oldest ?? 0)) / 1000);
    },
  };
}

export type CaptureEngine = Awaited<ReturnType<typeof startEngine>>;
