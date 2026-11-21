/**
 * Suggested moments in a file you're authorized to use (3.0 phase 5). Pure scoring over two
 * measured series, one value per second: loudness (dBFS) and visual change (0..255 mean |Δluma|
 * between keyframes, spread over the seconds between them). Scores are relative to the file
 * itself: "louder and busier than the rest of this video", never a prediction of virality.
 */
import type { SuggestedMoment } from "@/local/sources";

export interface MomentOptions {
  clipSeconds: number;
  /** Seconds kept before the peak (the rest comes after). */
  preRoll: number;
  max: number;
}

const DEFAULTS: MomentOptions = { clipSeconds: 30, preRoll: 20, max: 8 };

function stats(xs: number[]): { mean: number; sd: number } {
  const n = xs.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd };
}

/** Sliding mean over ±r seconds. */
function smooth(xs: number[], r: number): number[] {
  return xs.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(xs.length - 1, i + r); j++) {
      s += xs[j]!;
      n++;
    }
    return s / n;
  });
}

export function findMoments(loudnessDb: number[], visual: number[], durationSec: number, options: Partial<MomentOptions> = {}): SuggestedMoment[] {
  const o = { ...DEFAULTS, ...options };
  const n = Math.max(loudnessDb.length, visual.length);
  if (n < 5 || durationSec < 5) return [];
  const loud = smooth(Array.from({ length: n }, (_, i) => loudnessDb[i] ?? -90), 1);
  const vis = smooth(Array.from({ length: n }, (_, i) => visual[i] ?? 0), 1);
  const L = stats(loud);
  const V = stats(vis);
  const hasAudio = loudnessDb.some((x) => x > -80);
  const z = loud.map((l, i) => {
    const zl = hasAudio ? (l - L.mean) / L.sd : 0;
    const zv = (vis[i]! - V.mean) / V.sd;
    return { i, zl, zv, total: (hasAudio ? 0.65 : 0) * zl + (hasAudio ? 0.35 : 1) * zv };
  });
  const picked: SuggestedMoment[] = [];
  const taken: [number, number][] = [];
  for (const c of [...z].sort((a, b) => b.total - a.total)) {
    if (picked.length >= o.max) break;
    if (c.total < 1) break; // not clearly above this file's own normal
    const len = Math.min(o.clipSeconds, durationSec);
    let start = Math.max(0, c.i - o.preRoll);
    let end = start + len;
    if (end > durationSec) {
      end = durationSec;
      start = Math.max(0, end - len);
    }
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    taken.push([start, end]);
    const reasons: string[] = [];
    const kinds: string[] = [];
    if (c.zl >= 1) {
      reasons.push(`Louder than ${pct(c.zl)} of this video`);
      kinds.push("audio");
    }
    if (c.zv >= 1) {
      reasons.push(`More visual change than ${pct(c.zv)} of this video`);
      kinds.push("visual");
    }
    if (!reasons.length) reasons.push("Above this video's normal level");
    picked.push({ at: c.i, start, end, score: Math.round(Math.min(100, 40 + c.total * 15)), reasons, kinds });
  }
  return picked.sort((a, b) => a.at - b.at);
}

/** z-score → "about N%" of a normal distribution below it (rounded, for plain-language reasons). */
function pct(z: number): string {
  const p = 0.5 * (1 + erf(z / Math.SQRT2));
  return `${Math.min(99, Math.round(p * 100))}%`;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
