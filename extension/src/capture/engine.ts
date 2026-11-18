/**
 * Capture engine (runs in the offscreen document).
 *
 * tab stream (tabCapture, authorized once by the editor's click)
 *   → audio back to the speakers (capturing would otherwise mute the tab)
 *   → MediaStreamTrackProcessor → VideoEncoder (H.264, keyframe every 2 s) / AudioEncoder (AAC or Opus)
 *   → ChunkRing (the last N seconds, in memory) + a small JPEG every 2 s (thumbnails)
 *   → per second: audio features + motion/cuts/brightness → LiveSignals → fusion signals
 *   → AutoClipper (with chat/viewer signals from the worker) → MP4 → IndexedDB
 *
 * While no target is set (recorder waiting for a streamer) or paused, frames are read and dropped:
 * nothing is encoded or detected. Nothing leaves the browser.
 */
import type { Signal } from "@/detection/fusion";
import { createHighlight, deleteHighlight, markClipFailed, updateHighlight } from "@/local/highlights";
import { saveClip, saveFailureReason, updateClip, type DetectionType } from "@/local/clips";
import type { CaptureOptions, CaptureTarget, ClipRequest, SlotHealth } from "@/types/capture";
import { AutoClipper, type CutJob } from "./autoclip";
import { ChunkRing } from "./buffer";
import { muxMp4, type TrackConfigs } from "./mux";
import { AudioFeatureMeter, CUT_DIFF, LiveSignals } from "./signals";

const KEYFRAME_MS = 2000;
const SAMPLE_MS = 250; // motion sampling
const THUMB_MS = 2000;
const SILENT_DB = -70;
const VIDEO_CODECS = ["avc1.640028", "avc1.4d4028", "avc1.4d401f", "avc1.42001f"];

export interface EngineStatus {
  bufferedSeconds: number;
  levelDb: number | null;
  recording: boolean;
  /** Seconds encoded since the engine started. */
  recordedSeconds: number;
  silentSeconds: number;
  health: SlotHealth;
}

/** Capture size and bitrate per quality setting. */
export const QUALITY = {
  "720p": { maxWidth: 1280, maxHeight: 720, bitrate: 3_000_000 },
  "480p": { maxWidth: 854, maxHeight: 480, bitrate: 1_500_000 },
} as const;

export interface EngineEvents {
  status: (s: EngineStatus) => void;
  clipSaved: (c: { clipId: number; highlightId: number; durationSec: number }) => void;
  clipFailed: (c: { highlightId: number; reason: string }) => void;
  detection: (d: { at: number; reasons: string[]; score: number; clipped: boolean }) => void;
  ended: (reason: string) => void;
}

interface Processor<T> {
  readable: ReadableStream<T>;
}
declare const MediaStreamTrackProcessor: { new <T>(init: { track: MediaStreamTrack }): Processor<T> };

async function pickVideoCodec(width: number, height: number, bitrate: number): Promise<VideoEncoderConfig> {
  for (const codec of VIDEO_CODECS) {
    const cfg: VideoEncoderConfig = { codec, width, height, bitrate, framerate: 30, latencyMode: "realtime", avc: { format: "avc" } };
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

/** The buffer must hold a moment's pre-roll, the moment and its post-roll, with a margin. */
export function effectiveBufferSeconds(o: Pick<CaptureOptions, "bufferSeconds" | "preRollSeconds" | "postRollSeconds">): number {
  return Math.max(o.bufferSeconds, o.preRollSeconds + o.postRollSeconds + 70);
}

/** Counters for diagnosing a capture (read from the offscreen document's console). */
export const captureStats = { videoFrames: 0, videoChunks: 0, audioFrames: 0, audioChunks: 0, signals: 0, errors: [] as string[] };
(globalThis as { __streamhunterCapture?: typeof captureStats }).__streamhunterCapture = captureStats;

export async function startEngine(streamId: string, initialTarget: CaptureTarget | null, initialOpts: CaptureOptions, on: EngineEvents) {
  const mandatory = { chromeMediaSource: "tab", chromeMediaSourceId: streamId };
  const q = QUALITY[initialOpts.quality ?? "720p"];
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory } as unknown as MediaTrackConstraints,
    video: { mandatory: { ...mandatory, maxWidth: q.maxWidth, maxHeight: q.maxHeight, maxFrameRate: 30 } } as unknown as MediaTrackConstraints,
  });
  const [vTrack] = stream.getVideoTracks();
  const [aTrack] = stream.getAudioTracks();
  if (!vTrack) throw new Error("The tab has no video to capture.");

  // Capturing mutes the tab; its sound plays here only for the slot the editor listens to.
  const ctx = new AudioContext();
  const speaker = ctx.createGain();
  speaker.gain.value = initialOpts.listen === false ? 0 : 1;
  speaker.connect(ctx.destination);
  if (aTrack) ctx.createMediaStreamSource(new MediaStream([aTrack])).connect(speaker);

  let opts = initialOpts;
  let target = initialTarget;
  let paused = false;
  const isActive = () => target !== null && !paused;

  const settings = vTrack.getSettings();
  const width = Math.max(2, Math.floor((settings.width ?? 1280) / 2) * 2);
  const height = Math.max(2, Math.floor((settings.height ?? 720) / 2) * 2);
  const vCfg = await pickVideoCodec(width, height, q.bitrate);
  const ring = new ChunkRing(effectiveBufferSeconds(opts) * 1000);
  const signals = new LiveSignals();
  const aSettings = aTrack?.getSettings();
  const meter = new AudioFeatureMeter(aSettings?.sampleRate ?? 48_000);
  const configs: TrackConfigs = { video: { width, height, decoderConfig: { codec: vCfg.codec, codedWidth: width, codedHeight: height } }, audio: null };
  const manual: ClipRequest[] = [];
  const thumbs: { at: number; blob: Blob }[] = [];
  let stopped = false;
  let recordedMs = 0;
  let silentSeconds = 0;
  let latestDb: number | null = null;
  let throttled = false;
  let dropped = 0;
  let droppedAtReport = 0;
  let encodedSinceReport = 0;
  let lastReport = Date.now();
  let lastEncodedAt = 0;
  let noVideoSeconds = 0;
  let blackSeconds = 0;

  // --- video -----------------------------------------------------------------------------------
  let vBase: { wall: number; ts: number } | null = null;
  const vAt = (ts: number) => (vBase ? vBase.wall + (ts - vBase.ts) / 1000 : Date.now());
  let needKey = true;
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
  const thumbCanvas = new OffscreenCanvas(320, Math.round((320 * height) / width / 2) * 2 || 180);
  const tg = thumbCanvas.getContext("2d")!;
  let prevLuma: Float32Array | null = null;
  let lastSample = 0;
  let lastKey = 0;
  let lastThumb = 0;
  let lastFrameAt = 0;
  let secMotion: number[] = [];
  let secBright: number[] = [];
  let secCuts = 0;

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
      const diff = d / luma.length;
      secMotion.push(diff);
      if (diff >= CUT_DIFF) secCuts += 1;
    }
    prevLuma = luma;
  }

  function thumbnail(frame: VideoFrame, at: number) {
    tg.drawImage(frame, 0, 0, thumbCanvas.width, thumbCanvas.height);
    void thumbCanvas
      .convertToBlob({ type: "image/jpeg", quality: 0.7 })
      .then((blob) => {
        thumbs.push({ at, blob });
        const cutoff = at - effectiveBufferSeconds(opts) * 1000;
        while (thumbs.length && thumbs[0]!.at < cutoff) thumbs.shift();
      })
      .catch(() => undefined);
  }

  void (async () => {
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track: vTrack }).readable.getReader();
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      captureStats.videoFrames += 1;
      if (!vBase) vBase = { wall: Date.now(), ts: frame.timestamp };
      const at = vAt(frame.timestamp);
      if (isActive()) {
        if (lastFrameAt) recordedMs += Math.min(1000, Math.max(0, at - lastFrameAt));
        lastFrameAt = at;
        if (at - lastSample >= SAMPLE_MS) {
          lastSample = at;
          try {
            sample(frame);
          } catch {
            /* a frame that can't be drawn is skipped */
          }
        }
        if (at - lastThumb >= THUMB_MS) {
          lastThumb = at;
          try {
            thumbnail(frame, at);
          } catch {
            /* thumbnails are best effort */
          }
        }
        // Throttled: encode at most every ~60 ms (half of 30 fps) to save CPU.
        const skip = throttled && at - lastEncodedAt < 60;
        if (vEnc.state === "configured" && vEnc.encodeQueueSize >= 8) dropped += 1;
        else if (vEnc.state === "configured" && !skip) {
          const keyFrame = needKey || at - lastKey >= KEYFRAME_MS;
          if (keyFrame) {
            lastKey = at;
            needKey = false;
          }
          lastEncodedAt = at;
          encodedSinceReport += 1;
          vEnc.encode(frame, { keyFrame });
        }
      } else {
        lastFrameAt = 0;
        needKey = true; // the next recorded chunk must start with a keyframe
      }
      frame.close();
    }
  })().catch((e: unknown) => captureStats.errors.push(`video reader: ${e instanceof Error ? e.message : String(e)}`));

  // --- audio -----------------------------------------------------------------------------------
  let aEnc: AudioEncoder | null = null;
  if (aTrack) {
    const picked = await pickAudioCodec(aSettings?.sampleRate ?? 48_000, Math.min(2, aSettings?.channelCount ?? 2));
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
          if (isActive()) {
            try {
              const n = Math.min(audio.numberOfFrames, plane.length);
              audio.copyTo(plane.subarray(0, n), { planeIndex: 0, format: "f32-planar", frameCount: n });
              meter.add(plane.subarray(0, n));
            } catch {
              /* features are best effort */
            }
            if (enc.state === "configured") enc.encode(audio);
          }
          audio.close();
        }
      })().catch((e: unknown) => captureStats.errors.push(`audio reader: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // --- clips -------------------------------------------------------------------------------------
  function thumbFor(at: number, from: number, to: number): Blob | null {
    let best: { at: number; blob: Blob } | null = null;
    for (const t of thumbs) if (t.at >= from && t.at <= to && (!best || Math.abs(t.at - at) < Math.abs(best.at - at))) best = t;
    return best?.blob ?? null;
  }

  async function fail(highlightId: number, reason: string): Promise<null> {
    await markClipFailed(highlightId, reason).catch(() => undefined);
    on.clipFailed({ highlightId, reason });
    return null;
  }

  async function save(job: { target: CaptureTarget; highlightId: number; start: number; end: number; peakAt: number; title: string; score: number; reasons: string[]; types: DetectionType[]; explain?: CutJob["explain"] }): Promise<number | null> {
    const sel = ring.select(job.start, job.end);
    if (!sel) return fail(job.highlightId, "That moment is no longer in the recording buffer.");
    let blob: Blob;
    try {
      blob = muxMp4(sel.video, sel.audio, configs);
    } catch (e) {
      return fail(job.highlightId, `The MP4 could not be built (${e instanceof Error ? e.message : "error"}).`);
    }
    const t = job.target;
    const clip = await saveClip({
      candidateId: job.highlightId, sessionId: t.sessionId, streamerId: t.streamerId, streamerName: t.displayName, platform: t.platform,
      title: job.title, startedAt: sel.from, durationSec: (sel.to - sel.from) / 1000, width, height, score: job.score, blob,
      category: t.category ?? null, reasons: job.reasons, detectionTypes: job.types, peakAt: job.peakAt,
      broadcastStartedAt: t.broadcastStartedAt, thumbnail: thumbFor(job.peakAt, sel.from, sel.to), explain: job.explain ?? null,
    }).catch((e: unknown) => e as Error);
    if (clip instanceof Error) return fail(job.highlightId, saveFailureReason(clip));
    on.clipSaved({ clipId: clip.id, highlightId: job.highlightId, durationSec: (sel.to - sel.from) / 1000 });
    return clip.id;
  }

  const clipper = new AutoClipper(opts, () => target, {
    createHighlight,
    updateHighlight,
    deleteHighlight,
    cut: (job: CutJob) => save({ ...job, types: job.kinds }),
    amendClip: async (clipId, reasons, score) => void (await updateClip(clipId, { reasons, score })),
    onDetection: (d) => on.detection(d),
  });

  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (isActive()) {
      const f = meter.take();
      latestDb = f?.db ?? null;
      silentSeconds = f && f.db > SILENT_DB ? 0 : silentSeconds + 1;
      noVideoSeconds = secBright.length === 0 ? noVideoSeconds + 1 : 0;
      blackSeconds = secBright.length > 0 && Math.max(...secBright) < 12 ? blackSeconds + 1 : secBright.length > 0 ? 0 : blackSeconds;
      const sorted = [...secMotion].sort((a, b) => a - b);
      signals.add({
        t: now,
        db: f?.db ?? null,
        zcr: f?.zcr ?? null,
        envelope: f?.envelope ?? null,
        motion: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null, // median: one hard cut isn't action
        brightness: secBright.length ? Math.max(...secBright) : null,
        cuts: secMotion.length ? secCuts : null,
      });
      secMotion = [];
      secBright = [];
      secCuts = 0;
      for (const s of signals.detect(now)) {
        captureStats.signals += 1;
        void clipper.signal(s);
      }
      void clipper.tick(now, ring.newest);
    }

    for (const req of [...manual]) {
      if ((ring.newest ?? 0) >= req.end || now > req.end + 5000) {
        manual.splice(manual.indexOf(req), 1);
        if (!target) continue;
        void save({ target, highlightId: req.highlightId, start: req.start, end: req.end, peakAt: req.end, title: req.title, score: req.score, reasons: ["Saved by you"], types: ["manual"] }).catch(
          (e: unknown) => on.clipFailed({ highlightId: req.highlightId, reason: e instanceof Error ? e.message : "Clip failed" }),
        );
      }
    }
    if (++ticks % 3 === 0) {
      const secs = Math.max(0.5, (now - lastReport) / 1000);
      const fps = Math.round((encodedSinceReport / secs) * 10) / 10;
      encodedSinceReport = 0;
      lastReport = now;
      const droppedRecent = dropped - droppedAtReport;
      droppedAtReport = dropped;
      on.status({
        bufferedSeconds: Math.round(((ring.newest ?? now) - (ring.oldest ?? now)) / 1000),
        levelDb: isActive() ? latestDb : null,
        recording: isActive(),
        recordedSeconds: Math.round(recordedMs / 1000),
        silentSeconds,
        health: { fps: isActive() ? fps : 0, dropped, droppedRecent, queue: vEnc.state === "configured" ? vEnc.encodeQueueSize : 0, throttled,
          pendingClips: clipper.pendingCount() + manual.length, noVideoSeconds: isActive() ? noVideoSeconds : 0, blackSeconds: isActive() ? blackSeconds : 0 },
      });
    }
  }, 1000);

  vTrack.addEventListener("ended", () => void stop("The tab was closed or stopped sharing."));

  /** Forget the previous streamer's footage and normal (the recorder switched channel). */
  function clearBuffer() {
    ring.clear();
    signals.reset();
    thumbs.length = 0;
    prevLuma = null;
    needKey = true;
  }

  async function stop(reason = "Stopped") {
    if (stopped) return;
    // Moments still waiting for their post-roll: cut what we have.
    await clipper.flush().catch(() => undefined);
    stopped = true;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    for (const enc of [vEnc, aEnc]) if (enc && enc.state !== "closed") enc.close();
    void ctx.close();
    on.ended(reason);
  }

  return {
    requestClip(req: ClipRequest) {
      manual.push(req);
    },
    /** A chat or viewer signal from the worker for the streamer being recorded. */
    signal(s: Signal) {
      if (isActive()) void clipper.signal(s);
    },
    /** Switch streamer (or null = wait). Pending clips of the previous streamer are cut first. */
    async setTarget(next: CaptureTarget | null) {
      noVideoSeconds = 0;
      blackSeconds = 0;
      if (target && next && target.streamerId === next.streamerId) {
        target = next; // same streamer, fresher session/category
        return;
      }
      await clipper.flush().catch(() => undefined);
      clipper.reset();
      clearBuffer();
      target = next;
    },
    async setPaused(p: boolean) {
      if (p && !paused) await clipper.flush().catch(() => undefined);
      paused = p;
      if (p) needKey = true;
    },
    setListening(on: boolean) {
      speaker.gain.value = on ? 1 : 0;
    },
    setThrottled(on: boolean) {
      throttled = on;
    },
    updateOptions(next: CaptureOptions) {
      if (typeof next.listen === "boolean") speaker.gain.value = next.listen ? 1 : 0;
      opts = next;
      ring.keepMs = effectiveBufferSeconds(next) * 1000;
      clipper.updateOptions(next);
    },
    stop,
    get bufferedSeconds() {
      return Math.round(((ring.newest ?? 0) - (ring.oldest ?? 0)) / 1000);
    },
  };
}

export type CaptureEngine = Awaited<ReturnType<typeof startEngine>>;
