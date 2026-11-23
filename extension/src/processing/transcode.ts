/**
 * Clip → vertical 9:16 or landscape MP4 with WebCodecs (3.0 phase 5). Runs in an extension
 * document (the offscreen document): decode the source H.264/HEVC/VP9/AV1 track, draw each frame
 * with the layout plan, encode H.264, keep the audio (AAC passes through untouched; other audio is
 * re-encoded to AAC when the browser can). The result is demuxed again and checked before use.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { Sample } from "mp4box";
import type { VerticalLayout } from "@/types/api";
import { demux, durUs, MediaError, ptsUs, type Demuxed } from "./demux";
import { ActionTracker, columnEnergy, planLandscape, planVertical, VERTICAL, type LayoutKind, type Plan } from "./layout";

export interface TranscodeOptions {
  kind: "vertical" | "landscape";
  layout?: VerticalLayout | null;
  /** Seconds from the start of the file (default: whole file). */
  startSec?: number;
  endSec?: number;
  /** Where to take the thumbnail from, in seconds of the output. */
  thumbAtSec?: number;
  onProgress?: (fraction: number) => void;
}

export interface TranscodeResult {
  blob: Blob;
  width: number;
  height: number;
  durationSec: number;
  thumbnail: Blob | null;
  used: LayoutKind | "landscape";
  notes: string[];
  audio: "aac" | "opus" | "none";
  /** Vertical only: where the action window was, [seconds into the output, 0..1] every 0.25 s (4.0 editing reuses it). */
  actionPath: [number, number][];
}

const VIDEO_CODECS = ["avc1.64002A", "avc1.640028", "avc1.4D402A", "avc1.42E02A", "avc1.42E01F"];
const BATCH = 90;

async function encoderConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(Math.min(12_000_000, Math.max(2_500_000, width * height * fps * 0.11)));
  for (const codec of VIDEO_CODECS) {
    const cfg: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: "avc" }, latencyMode: "quality" };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
  }
  throw new MediaError("This browser can't encode H.264 video at this size (WebCodecs).");
}

/** The samples to decode for [startUs, endUs): from the keyframe at or before the start to the next keyframe after the end. */
export function sampleRange(samples: Pick<Sample, "cts" | "timescale" | "is_sync">[], startUs: number, endUs: number): [number, number] {
  let first = 0;
  for (let i = 0; i < samples.length; i++) {
    if (ptsUs(samples[i] as Sample) > startUs) break;
    if (samples[i]!.is_sync) first = i;
  }
  let last = samples.length;
  for (let i = first + 1; i < samples.length; i++)
    if (samples[i]!.is_sync && ptsUs(samples[i] as Sample) >= endUs) {
      last = i;
      break;
    }
  return [first, last];
}

export async function transcode(input: Blob | Demuxed, opts: TranscodeOptions): Promise<TranscodeResult> {
  if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") throw new MediaError("This browser doesn't support WebCodecs video processing.");
  const src = input instanceof Blob ? await demux(input) : input;
  const v = src.video;
  const startUs = Math.max(0, Math.round((opts.startSec ?? 0) * 1e6));
  const endUs = Math.round(Math.min(opts.endSec ?? src.durationSec, src.durationSec) * 1e6);
  if (endUs - startUs < 500_000) throw new MediaError("The selected part is too short (under half a second).");

  const decCfg: VideoDecoderConfig = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) };
  if (!(await VideoDecoder.isConfigSupported(decCfg)).supported) throw new MediaError(`This browser can't decode this video (${v.codec}).`);

  const [first, last] = sampleRange(v.samples, startUs, endUs);
  const vs = v.samples.slice(first, last);
  const frameDur = vs.length > 1 ? Math.max(1, (ptsUs(vs[vs.length - 1]!) - ptsUs(vs[0]!)) / (vs.length - 1)) : 33_333;
  const fps = Math.min(60, Math.max(15, Math.round(1e6 / frameDur)));

  const tracker = new ActionTracker();
  const actionPath: [number, number][] = [];
  const firstPlan = opts.kind === "vertical" ? planVertical(v.width, v.height, opts.layout, 0.5, VERTICAL) : planLandscape(v.width, v.height);
  const W = firstPlan.width;
  const H = firstPlan.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const probe = new OffscreenCanvas(64, 36);
  const pctx = probe.getContext("2d", { willReadFrequently: true })!;
  // Average the picture when shrinking it to 64×36 (high quality uses mipmaps). The default low
  // quality samples only a few pixels, so small or slow motion is missed on most frames.
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  let prevGray: Uint8ClampedArray | null = null;

  const encCfg = await encoderConfig(W, H, fps);
  const audioPlan = await planAudio(src);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    audio: audioPlan.codec !== "none" ? { codec: audioPlan.codec, sampleRate: audioPlan.sampleRate, numberOfChannels: audioPlan.channels } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "cross-track-offset",
  });

  let failure: Error | null = null;
  const fail = (e: unknown) => {
    failure ??= e instanceof Error ? e : new MediaError(String(e));
  };
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  encoder.configure(encCfg);

  let thumbnail: Blob | null = null;
  const thumbAtUs = Math.round((opts.thumbAtSec ?? Math.min(1, (endUs - startUs) / 2e6)) * 1e6);
  let thumbPending: Promise<void> | null = null;
  let frames = 0;
  let lastKeyUs = -Infinity;
  let usedPlan: Plan = firstPlan;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const t = frame.timestamp;
        if (t < startUs || t >= endUs || failure) return;
        let plan = firstPlan;
        if (opts.kind === "vertical" && (opts.layout?.kind === "action" || (opts.layout?.kind === "facecam_top" && opts.layout.facecam))) {
          pctx.drawImage(frame, 0, 0, 64, 36);
          const px = pctx.getImageData(0, 0, 64, 36).data;
          const gray = new Uint8ClampedArray(64 * 36);
          for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4]! * 3 + px[i * 4 + 1]! * 6 + px[i * 4 + 2]!) / 10;
          if (prevGray) tracker.update(columnEnergy(prevGray, gray, 64, 36));
          prevGray = gray;
          plan = planVertical(v.width, v.height, opts.layout, tracker.position, VERTICAL);
          const sec = (t - startUs) / 1e6;
          if (!actionPath.length || sec - actionPath[actionPath.length - 1]![0] >= 0.25) actionPath.push([Math.round(sec * 100) / 100, Math.round(tracker.position * 1000) / 1000]);
        }
        usedPlan = plan;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        for (const d of plan.draws) ctx.drawImage(frame, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
        const ts = t - startUs;
        const out = new VideoFrame(canvas, { timestamp: ts, duration: frame.duration ?? Math.round(frameDur) });
        const key = ts - lastKeyUs >= 2_000_000;
        if (key) lastKeyUs = ts;
        encoder.encode(out, { keyFrame: key });
        out.close();
        frames++;
        if (!thumbnail && !thumbPending && ts >= thumbAtUs) thumbPending = thumbOf(canvas).then((b) => void (thumbnail = b));
      } catch (e) {
        fail(e);
      } finally {
        frame.close();
      }
    },
    error: fail,
  });
  decoder.configure(decCfg);

  for (let i = 0; i < vs.length && !failure; i += BATCH) {
    const batch = vs.slice(i, i + BATCH);
    const data = await src.read(batch);
    for (let k = 0; k < batch.length; k++) {
      const s = batch[k]!;
      decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: ptsUs(s), duration: durUs(s), data: data[k]! }));
      while (decoder.decodeQueueSize > 12 || encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    }
    opts.onProgress?.(Math.min(0.95, (i + batch.length) / vs.length));
  }
  if (!failure) await decoder.flush().catch(fail);
  if (!failure) await encoder.flush().catch(fail);
  decoder.close();
  encoder.close();
  if (failure) throw failure;
  if (frames === 0) throw new MediaError("No video frames in the selected part.");
  if (!thumbnail && !thumbPending) thumbPending = thumbOf(canvas).then((b) => void (thumbnail = b));
  await thumbPending;

  await audioPlan.mux(muxer, src, startUs, endUs);
  muxer.finalize();
  const blob = new Blob([new Uint8Array(target.buffer)], { type: "video/mp4" });
  const durationSec = (endUs - startUs) / 1e6;
  await validate(blob, W, H, durationSec);
  opts.onProgress?.(1);
  return { blob, width: W, height: H, durationSec: Math.round(durationSec * 10) / 10, thumbnail, used: opts.kind === "landscape" ? "landscape" : usedPlan.used, notes: [...usedPlan.notes, ...audioPlan.notes], audio: audioPlan.codec, actionPath };
}

async function thumbOf(canvas: OffscreenCanvas): Promise<Blob | null> {
  try {
    const w = 360;
    const h = Math.round((canvas.height / canvas.width) * w);
    const small = new OffscreenCanvas(w, h);
    small.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
    return await small.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  } catch {
    return null;
  }
}

interface AudioPlan {
  codec: "aac" | "opus" | "none";
  sampleRate: number;
  channels: number;
  notes: string[];
  mux: (m: Muxer<ArrayBufferTarget>, src: Demuxed, startUs: number, endUs: number) => Promise<void>;
}

/** AAC passes through untouched; other audio is re-encoded to AAC when possible, else kept as it is. */
async function planAudio(src: Demuxed): Promise<AudioPlan> {
  const a = src.audio;
  const none: AudioPlan = { codec: "none", sampleRate: 48000, channels: 2, notes: a ? [] : ["The source has no audio."], mux: async () => undefined };
  if (!a) return none;
  const inRange = (s: Sample, startUs: number, endUs: number) => ptsUs(s) >= startUs && ptsUs(s) < endUs;
  if (/^mp4a/.test(a.codec)) {
    return {
      codec: "aac", sampleRate: a.sampleRate, channels: a.channels, notes: [],
      async mux(m, s, startUs, endUs) {
        const picked = a.samples.filter((x) => inRange(x, startUs, endUs));
        const data = await s.read(picked);
        picked.forEach((x, i) =>
          m.addAudioChunkRaw(data[i]!, "key", ptsUs(x) - startUs, durUs(x), i === 0 ? { decoderConfig: { codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.description ? { description: a.description } : {}) } } : undefined),
        );
      },
    };
  }
  const decCfg: AudioDecoderConfig = { codec: a.codec === "Opus" ? "opus" : a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.description ? { description: a.description } : {}) };
  const encCfg: AudioEncoderConfig = { codec: "mp4a.40.2", sampleRate: a.sampleRate, numberOfChannels: a.channels, bitrate: 128_000 };
  const canDecode = typeof AudioDecoder !== "undefined" && (await AudioDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }))).supported;
  const canEncode = typeof AudioEncoder !== "undefined" && (await AudioEncoder.isConfigSupported(encCfg).catch(() => ({ supported: false }))).supported;
  if (canDecode && canEncode) {
    return {
      codec: "aac", sampleRate: a.sampleRate, channels: a.channels, notes: ["Audio re-encoded to AAC."],
      async mux(m, s, startUs, endUs) {
        let err: unknown = null;
        const enc = new AudioEncoder({ output: (c, meta) => m.addAudioChunk(c, meta), error: (e) => (err = e) });
        enc.configure(encCfg);
        const dec = new AudioDecoder({ output: (d) => (enc.encode(d), d.close()), error: (e) => (err = e) });
        dec.configure(decCfg);
        const picked = a.samples.filter((x) => inRange(x, startUs, endUs));
        const data = await s.read(picked);
        picked.forEach((x, i) => dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ptsUs(x) - startUs, duration: durUs(x), data: data[i]! })));
        await dec.flush();
        await enc.flush();
        dec.close();
        enc.close();
        if (err) throw err instanceof Error ? err : new MediaError("Audio re-encoding failed.");
      },
    };
  }
  if (/^opus/i.test(a.codec)) {
    return {
      codec: "opus", sampleRate: a.sampleRate, channels: a.channels, notes: ["Audio kept as Opus (this browser can't encode AAC); X needs AAC."],
      async mux(m, s, startUs, endUs) {
        const picked = a.samples.filter((x) => inRange(x, startUs, endUs));
        const data = await s.read(picked);
        picked.forEach((x, i) => m.addAudioChunkRaw(data[i]!, "key", ptsUs(x) - startUs, durUs(x), i === 0 ? { decoderConfig: decCfg } : undefined));
      },
    };
  }
  return { ...none, notes: [`Audio dropped: this browser can't convert ${a.codec} audio.`] };
}

/** Re-reads the output: right size, has frames, about the right length. */
export async function validate(blob: Blob, width: number, height: number, durationSec: number): Promise<void> {
  const d = await demux(blob);
  if (d.video.width !== width || d.video.height !== height) throw new MediaError(`Output check failed: ${d.video.width}×${d.video.height} instead of ${width}×${height}.`);
  if (Math.abs(d.durationSec - durationSec) > Math.max(1.5, durationSec * 0.05)) throw new MediaError(`Output check failed: ${d.durationSec.toFixed(1)} s instead of ${durationSec.toFixed(1)} s.`);
}
