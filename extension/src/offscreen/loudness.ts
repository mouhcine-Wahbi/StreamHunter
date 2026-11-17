/** One second of loudness. */
export interface LoudnessSample {
  /** ISO time of the second. */
  t: string;
  db: number;
}

export const FLOOR_DB = -90;

/**
 * Accumulates audio frames and yields one RMS loudness value (dBFS) per call to `take`.
 * Same measure as the backend's post-stream analysis (FFmpeg astats RMS level).
 */
export class LoudnessMeter {
  private sumSq = 0;
  private n = 0;

  add(frame: ArrayLike<number>): void {
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] ?? 0;
      this.sumSq += v * v;
    }
    this.n += frame.length;
  }

  /** Loudness since the previous call, or null if no audio frames arrived. */
  take(at: Date): LoudnessSample | null {
    if (this.n === 0) return null;
    const rms = Math.sqrt(this.sumSq / this.n);
    this.sumSq = 0;
    this.n = 0;
    const db = rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
    return { t: at.toISOString(), db: Math.round(db * 10) / 10 };
  }
}
