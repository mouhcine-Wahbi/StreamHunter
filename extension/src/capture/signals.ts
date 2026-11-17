/**
 * Live signals from a captured stream, one value per second:
 * - loudness (RMS dBFS) → "audio peak" when well above this stream's own rolling median;
 * - motion (mean absolute luma change between sampled frames, 0–255) → "fast action" when far
 *   above the usual motion, and brightness jumps that come back down → "sudden flash".
 * Same rules as the original post-stream analysis, applied as the stream plays.
 */
export const BASELINE_SECONDS = 120;
const MIN_HISTORY = 30;
const PEAK_DB = 6; // dB above the rolling median that counts as loud
const FULL_DB = 18; // → audio score 100
const ACTION_RATIO = 2.5;
const ACTION_MIN = 8;
const MIN_BASELINE_MOTION = 1.5;
const FLASH_JUMP = 50;

export interface Second {
  t: number; // wall-clock ms of the second
  db: number | null;
  motion: number | null;
  brightness: number | null;
}

export interface Moment {
  at: number;
  audio: number | null;
  visual: number | null;
  reasons: string[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export class LiveSignals {
  private seconds: Second[] = [];

  add(s: Second): void {
    this.seconds.push(s);
    const cutoff = s.t - (BASELINE_SECONDS + 60) * 1000;
    while (this.seconds.length && this.seconds[0]!.t < cutoff) this.seconds.shift();
  }

  get length() {
    return this.seconds.length;
  }

  private history(before: number) {
    return this.seconds.filter((x) => x.t < before && x.t >= before - BASELINE_SECONDS * 1000);
  }

  /** Audio and visual scores (0–100) for a window, against the stream's own recent normal. */
  window(start: number, end: number): { audio: number | null; visual: number | null; loudestDb: number | null; motionRatio: number | null } {
    const hist = this.history(start);
    const win = this.seconds.filter((x) => x.t >= start && x.t <= end);
    const dbs = hist.map((x) => x.db).filter((x): x is number => x !== null);
    const motions = hist.map((x) => x.motion).filter((x): x is number => x !== null);
    let audio: number | null = null;
    let loudestDb: number | null = null;
    const winDb = win.map((x) => x.db).filter((x): x is number => x !== null);
    if (dbs.length >= MIN_HISTORY && winDb.length) {
      loudestDb = Math.round((Math.max(...winDb) - median(dbs)) * 10) / 10;
      audio = Math.round(Math.max(0, Math.min(100, (loudestDb / FULL_DB) * 100)));
    }
    let visual: number | null = null;
    let motionRatio: number | null = null;
    const winMotion = win.map((x) => x.motion).filter((x): x is number => x !== null);
    if (motions.length >= MIN_HISTORY && winMotion.length) {
      const usual = Math.max(MIN_BASELINE_MOTION, median(motions));
      const peak = Math.max(...winMotion);
      motionRatio = Math.round((peak / usual) * 10) / 10;
      visual = peak < ACTION_MIN ? 0 : Math.round(Math.max(0, Math.min(100, ((peak / usual - 1) / 2) * 100)));
    }
    return { audio, visual, loudestDb, motionRatio };
  }

  /**
   * A moment in the latest seconds: loud (≥ 6 dB over the median for 2 s), fast action (≥ 2.5× the
   * usual motion for 2 s), or a flash (brightness up ≥ 50 and back within 2 s). Null otherwise.
   */
  detect(now: number): Moment | null {
    const recent = this.seconds.filter((x) => x.t > now - 4000);
    if (recent.length < 3) return null;
    const hist = this.history(recent[0]!.t);
    if (hist.length < MIN_HISTORY) return null;
    const reasons: string[] = [];
    const baseDb = median(hist.map((x) => x.db).filter((x): x is number => x !== null));
    const loud = recent.filter((x) => x.db !== null && x.db - baseDb >= PEAK_DB);
    if (loud.length >= 2) reasons.push(`Stream audio ${Math.round(Math.max(...loud.map((x) => x.db! - baseDb)))} dB louder than usual`);
    const usual = Math.max(MIN_BASELINE_MOTION, median(hist.map((x) => x.motion).filter((x): x is number => x !== null)));
    const busy = recent.filter((x) => x.motion !== null && x.motion >= Math.max(ACTION_MIN, usual * ACTION_RATIO));
    if (busy.length >= 2) reasons.push(`Fast on-screen action (${(Math.max(...busy.map((x) => x.motion!)) / usual).toFixed(1)}× the usual motion)`);
    const b = recent.map((x) => x.brightness);
    for (let i = 1; i < b.length - 1; i++) {
      const before = b[i - 1];
      const at = b[i];
      const after = b[i + 1];
      if (before != null && at != null && after != null && at - before >= FLASH_JUMP && after - before < 20) {
        reasons.push("Sudden flash on screen");
        break;
      }
    }
    if (reasons.length === 0) return null;
    const w = this.window(now - 4000, now);
    return { at: now, audio: w.audio, visual: w.visual, reasons };
  }
}
