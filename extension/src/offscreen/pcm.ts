import type { PcmChunk } from "@/types/tab-audio";

export const PCM_RATE = 16_000;
/** Each batch repeats the last second of the previous one, so the backend's ~1 s windows don't miss the seam. */
export const OVERLAP_SECONDS = 1;
const MAX_SECONDS = 11; // the backend accepts up to 12 s per batch

/**
 * Turns the tab's audio (any sample rate, mono) into 16 kHz signed 16-bit samples for the sound
 * classifier. Each output sample is the average of the input samples it covers, a simple low-pass
 * that keeps the speech/laughter band and avoids aliasing.
 */
export class Downsampler {
  private readonly step: number;
  private pos = 0; // position of the next output sample, in input samples, relative to the next input block
  private acc = 0;
  private n = 0;

  constructor(inputRate: number) {
    this.step = inputRate / PCM_RATE;
  }

  push(input: ArrayLike<number>): Int16Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i] ?? 0;
      this.n += 1;
      if (i + 1 >= this.pos + this.step) {
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        out.push(Math.round(v * 32767));
        this.acc = 0;
        this.n = 0;
        this.pos += this.step;
      }
    }
    this.pos -= input.length;
    return Int16Array.from(out);
  }
}

/** Collects 16 kHz samples and hands them out as base64 batches that overlap by one second. */
export class PcmBatcher {
  private parts: Int16Array[] = [];
  private length = 0;
  private startMs: number | null = null;
  private tail: Int16Array = new Int16Array(0);
  private tailStartMs = 0;

  add(samples: Int16Array, nowMs: number): void {
    if (samples.length === 0) return;
    if (this.startMs === null) this.startMs = nowMs - (samples.length / PCM_RATE) * 1000;
    this.parts.push(samples);
    this.length += samples.length;
    const max = MAX_SECONDS * PCM_RATE;
    while (this.length > max && this.parts.length > 1) {
      // The backend was unreachable for a while: drop the oldest audio rather than grow forever.
      const dropped = this.parts.shift()!;
      this.length -= dropped.length;
      this.startMs += (dropped.length / PCM_RATE) * 1000;
    }
  }

  /** The new audio since the last call, preceded by the last second already sent; null when nothing is new. */
  take(): PcmChunk | null {
    if (this.length === 0 || this.startMs === null) return null;
    const all = new Int16Array(this.tail.length + this.length);
    all.set(this.tail, 0);
    let off = this.tail.length;
    for (const p of this.parts) {
      all.set(p, off);
      off += p.length;
    }
    const start = this.tail.length > 0 ? this.tailStartMs : this.startMs;
    const keep = Math.min(all.length, OVERLAP_SECONDS * PCM_RATE);
    this.tail = all.slice(all.length - keep);
    this.tailStartMs = start + ((all.length - keep) / PCM_RATE) * 1000;
    this.parts = [];
    this.length = 0;
    this.startMs = null;
    return { start: new Date(start).toISOString(), data: toBase64(all) };
  }
}

/** Little-endian 16-bit samples → base64 (what the backend expects). */
export function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((v, i) => view.setInt16(i * 2, v, true));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
