/**
 * Measures an authorized file for {@link findMoments}: loudness per second (decoding the audio
 * track) and visual change (decoding keyframes only, which is fast). Runs in the offscreen document.
 */
import { demux, durUs, MediaError, ptsUs } from "./demux";
import { findMoments } from "./moments";
import type { SuggestedMoment } from "@/local/sources";

export interface Analysis {
  durationSec: number;
  width: number;
  height: number;
  moments: SuggestedMoment[];
}

export async function analyzeFile(blob: Blob, onProgress?: (f: number) => void): Promise<Analysis> {
  const src = await demux(blob);
  const seconds = Math.max(1, Math.ceil(src.durationSec));
  const sumSq = new Float64Array(seconds);
  const count = new Float64Array(seconds);

  if (src.audio && typeof AudioDecoder !== "undefined") {
    const a = src.audio;
    const cfg: AudioDecoderConfig = { codec: /^mp4a/.test(a.codec) ? a.codec : a.codec.toLowerCase(), sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.description ? { description: a.description } : {}) };
    if ((await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) {
      const dec = new AudioDecoder({
        output: (d) => {
          try {
            const sec = Math.min(seconds - 1, Math.floor(d.timestamp / 1e6));
            const buf = new Float32Array(d.numberOfFrames);
            d.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
            let s = 0;
            for (let i = 0; i < buf.length; i += 4) s += buf[i]! * buf[i]!;
            sumSq[sec]! += s;
            count[sec]! += Math.ceil(buf.length / 4);
          } finally {
            d.close();
          }
        },
        error: () => undefined,
      });
      dec.configure(cfg);
      for (let i = 0; i < a.samples.length; i += 400) {
        const batch = a.samples.slice(i, i + 400);
        const data = await src.read(batch);
        batch.forEach((s, k) => dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ptsUs(s), duration: durUs(s), data: data[k]! })));
        while (dec.decodeQueueSize > 50) await new Promise((r) => setTimeout(r, 2));
        onProgress?.(0.5 * Math.min(1, (i + batch.length) / a.samples.length));
      }
      await dec.flush().catch(() => undefined);
      dec.close();
    }
  }
  const loudness = Array.from(sumSq, (s, i) => (count[i]! > 0 ? 10 * Math.log10(s / count[i]! + 1e-12) : -90));

  const visual = new Array<number>(seconds).fill(0);
  const v = src.video;
  const vCfg: VideoDecoderConfig = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) };
  if (typeof VideoDecoder === "undefined" || !(await VideoDecoder.isConfigSupported(vCfg)).supported) throw new MediaError(`This browser can't decode this video (${v.codec}).`);
  const probe = new OffscreenCanvas(64, 36);
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  let prev: { t: number; gray: Uint8ClampedArray } | null = null;
  const dec = new VideoDecoder({
    output: (f) => {
      try {
        ctx.drawImage(f, 0, 0, 64, 36);
        const px = ctx.getImageData(0, 0, 64, 36).data;
        const gray = new Uint8ClampedArray(64 * 36);
        for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4]! * 3 + px[i * 4 + 1]! * 6 + px[i * 4 + 2]!) / 10;
        const t = f.timestamp / 1e6;
        if (prev) {
          let d = 0;
          for (let i = 0; i < gray.length; i++) d += Math.abs(gray[i]! - prev.gray[i]!);
          d /= gray.length;
          for (let s = Math.floor(prev.t); s <= Math.min(seconds - 1, Math.floor(t)); s++) visual[s] = Math.max(visual[s]!, d);
        }
        prev = { t, gray };
      } finally {
        f.close();
      }
    },
    error: () => undefined,
  });
  dec.configure(vCfg);
  const keys = v.samples.filter((s) => s.is_sync);
  for (let i = 0; i < keys.length; i += 30) {
    const batch = keys.slice(i, i + 30);
    const data = await src.read(batch);
    batch.forEach((s, k) => dec.decode(new EncodedVideoChunk({ type: "key", timestamp: ptsUs(s), duration: durUs(s), data: data[k]! })));
    await dec.flush().catch(() => undefined); // each keyframe decodes on its own
    onProgress?.(0.5 + 0.5 * Math.min(1, (i + batch.length) / keys.length));
  }
  dec.close();

  return { durationSec: Math.round(src.durationSec * 10) / 10, width: v.width, height: v.height, moments: findMoments(loudness, visual, src.durationSec) };
}
