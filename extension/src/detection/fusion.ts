/**
 * Signal fusion: turns separate detections (stream audio, picture, chat, viewers) into scored
 * moments, and plans clips so the same footage is never saved twice.
 *
 * Pure (no Chrome, no timers): the capture engine feeds it signals and calls `poll(now)`.
 */

export type SignalKind = "audio" | "chat" | "visual" | "viewers";
export const SIGNAL_KINDS: readonly SignalKind[] = ["audio", "chat", "visual", "viewers"];

export interface Signal {
  kind: SignalKind;
  /** Wall-clock ms of the peak. */
  at: number;
  /** Optional span (chat moments have one); defaults to [at, at]. */
  start?: number;
  end?: number;
  /** 0–100: how strong this signal is against the stream's own normal. */
  intensity: number;
  reasons: string[];
  /** Provisional highlights this signal came from (merged into the clip if it is made). */
  highlightIds?: number[];
}

export interface FusionWeights {
  audio: number;
  chat: number;
  visual: number;
  viewers: number;
  /** Bonus when two or more kinds of signal fire together. */
  multi: number;
}

export interface FusionConfig {
  weights: FusionWeights;
  /** Minimum fused score (0–100) for a clip. */
  threshold: number;
  /** A moment closes this long after its last signal (chat reacts late). */
  quietMs: number;
  /** A moment never grows longer than this. */
  maxMs: number;
  /** A signal weaker than this does not count as present. */
  minIntensity: number;
}

export const DEFAULT_WEIGHTS: FusionWeights = { audio: 25, chat: 30, visual: 20, viewers: 15, multi: 10 };

export const DEFAULT_FUSION: FusionConfig = {
  weights: DEFAULT_WEIGHTS,
  threshold: 40,
  quietMs: 10_000,
  maxMs: 60_000,
  minIntensity: 25,
};

export interface FusedMoment {
  start: number;
  end: number;
  /** Time of the strongest signal. */
  peakAt: number;
  score: number;
  /** Strongest intensity per kind (null = that kind did not fire). */
  intensities: Record<SignalKind, number | null>;
  kinds: SignalKind[];
  reasons: string[];
  highlightIds: number[];
  /** Score ≥ threshold. */
  clip: boolean;
}

/** Fused score: Σ weight × intensity/100, plus the multi-signal bonus; 0–100. */
export function fusedScore(intensities: Partial<Record<SignalKind, number | null>>, cfg: Pick<FusionConfig, "weights" | "minIntensity">): number {
  let score = 0;
  let kinds = 0;
  for (const k of SIGNAL_KINDS) {
    const v = intensities[k];
    if (v === null || v === undefined || v < cfg.minIntensity) continue;
    kinds += 1;
    score += (cfg.weights[k] * Math.min(100, v)) / 100;
  }
  if (kinds >= 2) score += cfg.weights.multi;
  return Math.round(Math.min(100, score));
}

/** The best a single signal can score with these weights (used to warn in Settings). */
export function maxSingleSignalScore(w: FusionWeights): number {
  return Math.max(w.audio, w.chat, w.visual, w.viewers);
}

interface Group {
  signals: Signal[];
  start: number;
  end: number;
  last: number;
}

export class FusionEngine {
  private group: Group | null = null;

  constructor(public cfg: FusionConfig = DEFAULT_FUSION) {}

  /** Add a signal. Returns a moment if this signal closed the previous one (it came too late). */
  add(s: Signal): FusedMoment | null {
    const start = Math.min(s.start ?? s.at, s.at);
    const end = Math.max(s.end ?? s.at, s.at);
    let closed: FusedMoment | null = null;
    const g = this.group;
    if (g && (start > g.last + this.cfg.quietMs || end - g.start > this.cfg.maxMs)) {
      closed = this.close();
    }
    if (!this.group) this.group = { signals: [], start, end, last: s.at };
    const cur = this.group;
    cur.signals.push(s);
    cur.start = Math.min(cur.start, start);
    cur.end = Math.max(cur.end, end);
    cur.last = Math.max(cur.last, s.at);
    return closed;
  }

  /** Close the open moment if it has been quiet long enough. */
  poll(now: number): FusedMoment | null {
    const g = this.group;
    if (!g) return null;
    if (now - g.last >= this.cfg.quietMs || now - g.start >= this.cfg.maxMs) return this.close();
    return null;
  }

  /** Close whatever is open (capture stopping). */
  flush(): FusedMoment | null {
    return this.group ? this.close() : null;
  }

  reset(): void {
    this.group = null;
  }

  private close(): FusedMoment {
    const g = this.group!;
    this.group = null;
    const intensities: Record<SignalKind, number | null> = { audio: null, chat: null, visual: null, viewers: null };
    let peak = g.signals[0]!;
    for (const s of g.signals) {
      const cur = intensities[s.kind];
      if (cur === null || s.intensity > cur) intensities[s.kind] = Math.round(s.intensity);
      if (s.intensity > peak.intensity) peak = s;
    }
    const kinds = SIGNAL_KINDS.filter((k) => (intensities[k] ?? 0) >= this.cfg.minIntensity);
    const score = fusedScore(intensities, this.cfg);
    const reasons = [...new Set(g.signals.sort((a, b) => b.intensity - a.intensity).flatMap((s) => s.reasons))].slice(0, 6);
    return {
      start: g.start,
      end: g.end,
      peakAt: peak.at,
      score,
      intensities,
      kinds,
      reasons,
      highlightIds: [...new Set(g.signals.flatMap((s) => s.highlightIds ?? []))],
      clip: score >= this.cfg.threshold,
    };
  }
}

/** A planned clip: [start, end] wall-clock ms; `cut` once the file is saved. */
export interface PlannedClip {
  key: number;
  start: number;
  end: number;
  peakAt: number;
  score: number;
  cut: boolean;
}

export type PlanDecision =
  | { action: "new"; clip: PlannedClip }
  | { action: "extend"; clip: PlannedClip }
  | { action: "merge"; clip: PlannedClip };

/**
 * Overlap handling between clips of one capture:
 * - the moment's peak falls inside a clip already cut → merge (no new footage, reasons added);
 * - the moment overlaps a clip still waiting for its post-roll → extend that clip (≤ maxClipMs);
 * - its pre-roll overlaps a clip already cut → the new clip starts where that one ended;
 * - otherwise a new clip.
 */
export class ClipPlanner {
  private clips: PlannedClip[] = [];
  private nextKey = 1;

  constructor(
    public preRollMs: number,
    public postRollMs: number,
    public maxClipMs = 90_000,
  ) {}

  plan(m: Pick<FusedMoment, "start" | "end" | "peakAt" | "score">): PlanDecision {
    const start = m.start - this.preRollMs;
    const end = m.end + this.postRollMs;
    const last = this.clips.at(-1);
    if (last) {
      if (last.cut && m.peakAt >= last.start && m.peakAt <= last.end) {
        last.score = Math.max(last.score, m.score);
        return { action: "merge", clip: last };
      }
      if (!last.cut && start <= last.end && Math.max(end, last.end) - last.start <= this.maxClipMs) {
        last.end = Math.max(last.end, end);
        if (m.score > last.score) {
          last.score = m.score;
          last.peakAt = m.peakAt;
        }
        return { action: "extend", clip: last };
      }
    }
    let from = last && start < last.end ? last.end : start;
    if (end - from > this.maxClipMs) from = end - this.maxClipMs;
    const clip: PlannedClip = {
      key: this.nextKey++,
      start: from,
      end,
      peakAt: m.peakAt,
      score: m.score,
      cut: false,
    };
    this.clips.push(clip);
    if (this.clips.length > 50) this.clips.shift();
    return { action: "new", clip };
  }

  /** Clips whose post-roll has passed by `now` (not cut yet). */
  due(now: number): PlannedClip[] {
    return this.clips.filter((c) => !c.cut && now >= c.end);
  }

  pending(): PlannedClip[] {
    return this.clips.filter((c) => !c.cut);
  }

  markCut(key: number): void {
    const c = this.clips.find((x) => x.key === key);
    if (c) c.cut = true;
  }

  reset(): void {
    this.clips = [];
  }
}
