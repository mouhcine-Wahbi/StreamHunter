/**
 * Live signals from a captured stream, one value per second, each judged against this stream's own
 * rolling normal (the last 2 minutes):
 *
 * audio  - loudness (RMS dBFS) well above the median → "louder than usual";
 *        - a sudden jump from one second to the next → "sudden burst of sound";
 *        - loud with a high zero-crossing rate (noise-like, high-pitched) → shouting-like, or,
 *          when it is sustained and even, crowd/cheer-like noise;
 *        - a loudness envelope that pulses 3–7 times a second → laughter-like bursts.
 * visual - motion (mean |Δluma| between sampled frames) far above the usual → fast action;
 *        - whole-picture changes (scene cuts) more often than usual → rapid scene changes;
 *        - brightness that jumps and comes back → flash.
 *
 * These are signal-processing heuristics, not a trained sound or video classifier, and the
 * reasons say so ("-like"). Each detection is a fusion Signal with an intensity 0–100; one signal
 * alone never makes a clip (see detection/fusion.ts).
 */
import type { Signal } from "@/detection/fusion";

export const BASELINE_SECONDS = 120;
const MIN_HISTORY = 30;
const PEAK_DB = 6; // dB above the rolling median that counts as loud
const FULL_DB = 18; // → audio intensity 100
const BURST_DB = 12; // jump between consecutive seconds
const SHOUT_DB = 9;
const ZCR_RATIO = 1.4;
const LAUGH_RHYTHM = 0.5;
const ACTION_RATIO = 2.5;
const ACTION_MIN = 8;
const MIN_BASELINE_MOTION = 1.5;
const FLASH_JUMP = 50;
export const CUT_DIFF = 40; // mean |Δluma| of one sample pair that counts as a scene cut

export interface Second {
  t: number; // wall-clock ms of the second
  db: number | null;
  motion: number | null;
  brightness: number | null;
  /** Zero crossings per sample (0–1): higher for noise, hiss and high-pitched sound. */
  zcr?: number | null;
  /** Loudness of each 50 ms slice of this second, dB. */
  envelope?: number[] | null;
  /** Scene cuts in this second. */
  cuts?: number | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

/**
 * How strongly a loudness envelope (50 ms slices) pulses at 3.3–6.7 Hz: the peak normalised
 * autocorrelation at lags of 150–300 ms (0–1). Laughter ("ha-ha-ha") pulses around 4–6 Hz.
 */
export function rhythmScore(env: number[]): number {
  if (env.length < 16) return 0;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const x = env.map((v) => v - mean);
  const r0 = x.reduce((a, v) => a + v * v, 0);
  if (r0 / x.length < 2.25) return 0; // flatter than ±1.5 dB: no pulses
  const r: number[] = [1];
  for (let lag = 1; lag <= 6; lag++) {
    let acc = 0;
    for (let i = lag; i < x.length; i++) acc += x[i]! * x[i - lag]!;
    r.push(acc / r0);
  }
  // A pulse train dips and comes back (r falls, then rises again at the period). A slow change or a
  // single step only decays, so it never counts.
  let best = 0;
  for (let lag = 3; lag <= 6; lag++) {
    const dip = Math.min(...r.slice(1, lag));
    if (r[lag]! > 0 && r[lag]! - dip >= 0.3) best = Math.max(best, r[lag]!);
  }
  return Math.round(best * 100) / 100;
}

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

  /** Forget the stream's normal (the recorder switched to another channel). */
  reset(): void {
    this.seconds = [];
  }

  private history(before: number) {
    return this.seconds.filter((x) => x.t < before && x.t >= before - BASELINE_SECONDS * 1000);
  }

  /** Audio and visual detections in the latest seconds (empty when nothing stands out). */
  detect(now: number): Signal[] {
    const recent = this.seconds.filter((x) => x.t > now - 4000);
    if (recent.length < 3) return [];
    const hist = this.history(recent[0]!.t);
    if (hist.length < MIN_HISTORY) return [];
    const out: Signal[] = [];
    const audio = this.audio(recent, hist, now);
    if (audio) out.push(audio);
    const visual = this.visual(recent, hist, now);
    if (visual) out.push(visual);
    return out;
  }

  private audio(recent: Second[], hist: Second[], now: number): Signal | null {
    const histDb = nums(hist.map((x) => x.db));
    if (histDb.length < MIN_HISTORY) return null;
    const baseDb = median(histDb);
    const baseZcr = median(nums(hist.map((x) => x.zcr)));
    const excess = (x: Second) => (x.db === null ? -Infinity : x.db - baseDb);
    const reasons: string[] = [];
    let intensity = 0;

    const loud = recent.filter((x) => excess(x) >= PEAK_DB);
    const peakExcess = Math.max(...recent.map(excess));
    if (loud.length >= 2) {
      reasons.push(`Stream audio ${Math.round(peakExcess)} dB louder than usual`);
      intensity = (peakExcess / FULL_DB) * 100;
    }
    const last = recent.at(-1)!;
    const prev = recent.at(-2)!;
    if (last.db !== null && prev.db !== null && last.db - prev.db >= BURST_DB && excess(last) >= PEAK_DB) {
      reasons.push("Sudden burst of sound");
      intensity = Math.max(intensity, 55) + 10;
    }
    const noisy = (x: Second) => baseZcr > 0 && typeof x.zcr === "number" && x.zcr >= baseZcr * ZCR_RATIO;
    const loudNoisy = loud.filter(noisy);
    if (loudNoisy.length >= 3 && loudNoisy.every((x) => x.envelope && spread(x.envelope) < 3)) {
      reasons.push("Crowd/cheer-like noise");
      intensity += 15;
    } else if (recent.some((x) => excess(x) >= SHOUT_DB && noisy(x))) {
      reasons.push("Shouting/screaming-like sound");
      intensity += 15;
    }
    const env = recent.slice(-2).flatMap((x) => x.envelope ?? []);
    if (peakExcess >= 4 && rhythmScore(env) >= LAUGH_RHYTHM) {
      reasons.push("Laughter-like rhythmic bursts");
      intensity = Math.max(intensity, 45) + 15;
    }
    if (reasons.length === 0) return null;
    return { kind: "audio", at: now, intensity: clamp(intensity), reasons };
  }

  private visual(recent: Second[], hist: Second[], now: number): Signal | null {
    const reasons: string[] = [];
    let intensity = 0;
    const motions = nums(hist.map((x) => x.motion));
    if (motions.length >= MIN_HISTORY) {
      const usual = Math.max(MIN_BASELINE_MOTION, median(motions));
      const busy = recent.filter((x) => x.motion !== null && x.motion >= Math.max(ACTION_MIN, usual * ACTION_RATIO));
      if (busy.length >= 2) {
        const ratio = Math.max(...busy.map((x) => x.motion!)) / usual;
        reasons.push(`Fast on-screen action (${ratio.toFixed(1)}× the usual motion)`);
        intensity = ((ratio - 1) / 2) * 100;
      }
    }
    const histCuts = nums(hist.map((x) => x.cuts));
    if (histCuts.length >= MIN_HISTORY) {
      const usualPer4s = (histCuts.reduce((a, b) => a + b, 0) / histCuts.length) * 4;
      const cuts = nums(recent.map((x) => x.cuts)).reduce((a, b) => a + b, 0);
      if (cuts >= 2 && cuts > usualPer4s * 3 + 0.5) {
        reasons.push(`Rapid scene changes (${cuts} in 4 s)`);
        intensity = Math.max(intensity, 30 + 15 * (cuts - 1));
      }
    }
    const b = recent.map((x) => x.brightness);
    for (let i = 1; i < b.length - 1; i++) {
      const before = b[i - 1];
      const at = b[i];
      const after = b[i + 1];
      if (before != null && at != null && after != null && at - before >= FLASH_JUMP && after - before < 20) {
        reasons.push("Sudden flash on screen");
        intensity = Math.max(intensity, 50);
        break;
      }
    }
    if (reasons.length === 0) return null;
    return { kind: "visual", at: now, intensity: clamp(intensity), reasons };
  }
}

function spread(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
}

/**
 * Per-second audio features from raw samples: RMS loudness, zero-crossing rate and the loudness of
 * each 50 ms slice (for the rhythm check).
 */
export class AudioFeatureMeter {
  private sumSq = 0;
  private n = 0;
  private crossings = 0;
  private prev = 0;
  private sliceSq = 0;
  private sliceN = 0;
  private slices: number[] = [];

  constructor(private sampleRate = 48_000) {}

  add(frame: ArrayLike<number>): void {
    const sliceLen = Math.round(this.sampleRate / 20);
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] ?? 0;
      this.sumSq += v * v;
      this.sliceSq += v * v;
      if ((v >= 0) !== (this.prev >= 0)) this.crossings += 1;
      this.prev = v;
      if (++this.sliceN >= sliceLen) {
        this.slices.push(toDb(Math.sqrt(this.sliceSq / this.sliceN)));
        this.sliceSq = 0;
        this.sliceN = 0;
      }
    }
    this.n += frame.length;
  }

  /** Features since the previous call, or null if no audio arrived. */
  take(): { db: number; zcr: number; envelope: number[] } | null {
    if (this.n === 0) return null;
    const out = {
      db: Math.round(toDb(Math.sqrt(this.sumSq / this.n)) * 10) / 10,
      zcr: Math.round((this.crossings / this.n) * 1000) / 1000,
      envelope: this.slices,
    };
    this.sumSq = 0;
    this.n = 0;
    this.crossings = 0;
    this.slices = [];
    return out;
  }
}

const toDb = (rms: number) => (rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90);
