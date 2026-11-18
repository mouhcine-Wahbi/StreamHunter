/**
 * Automatic clipping for one capture: signals in → fused moments → planned clips → cut requests.
 * No WebCodecs or Chrome here, so it is tested directly; the engine supplies storage and cutting.
 */
import { ClipPlanner, dedupeReasons, FusionEngine, type FusedMoment, type Signal, type SignalKind } from "@/detection/fusion";
import type { NewHighlight } from "@/local/highlights";
import type { CaptureOptions, CaptureTarget } from "@/types/capture";

export interface CutJob {
  key: number;
  target: CaptureTarget;
  highlightId: number;
  start: number;
  end: number;
  peakAt: number;
  score: number;
  title: string;
  reasons: string[];
  kinds: SignalKind[];
}

export interface AutoClipDeps {
  createHighlight: (h: NewHighlight) => Promise<{ id: number }>;
  updateHighlight: (id: number, patch: { score?: number; reasons?: string[]; endAt?: number; breakdown?: Record<string, unknown> }) => Promise<unknown>;
  deleteHighlight: (id: number) => Promise<void>;
  /** Cut and save the clip; returns the clip id (null if the footage was gone). */
  cut: (job: CutJob) => Promise<number | null>;
  /** A clip saved earlier gets more evidence (an overlapping moment merged into it). */
  amendClip: (clipId: number, reasons: string[], score: number) => Promise<void>;
  onDetection?: (d: { at: number; reasons: string[]; score: number; clipped: boolean }) => void;
}

const CATEGORY: Record<SignalKind, string> = {
  chat: "audience_reaction",
  audio: "exciting_moment",
  visual: "gameplay_highlight",
  viewers: "audience_reaction",
};

export class AutoClipper {
  readonly fusion: FusionEngine;
  readonly planner: ClipPlanner;
  private jobs = new Map<number, CutJob>();
  private clipIds = new Map<number, number>(); // plan key → clip id
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    opts: CaptureOptions,
    private target: () => CaptureTarget | null,
    private deps: AutoClipDeps,
  ) {
    this.fusion = new FusionEngine(fusionConfig(opts));
    this.planner = new ClipPlanner(opts.preRollSeconds * 1000, opts.postRollSeconds * 1000, opts.maxClipSeconds * 1000);
  }

  updateOptions(opts: CaptureOptions): void {
    this.fusion.cfg = fusionConfig(opts);
    this.planner.preRollMs = opts.preRollSeconds * 1000;
    this.planner.postRollMs = opts.postRollSeconds * 1000;
    this.planner.maxClipMs = opts.maxClipSeconds * 1000;
  }

  /** Serialise all async work: highlights must exist before their clip is cut. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  signal(s: Signal): Promise<void> {
    return this.run(async () => {
      const closed = this.fusion.add(s);
      if (closed) await this.handle(closed);
    });
  }

  /** Once a second: close quiet moments, cut clips whose post-roll has passed. */
  tick(now: number, bufferNewest: number | null): Promise<void> {
    return this.run(async () => {
      const closed = this.fusion.poll(now);
      if (closed) await this.handle(closed);
      for (const c of this.planner.due(now)) {
        // Wait for the encoder to deliver the post-roll (≤ 5 s grace).
        if ((bufferNewest ?? 0) < c.end && now < c.end + 5000) continue;
        await this.cutPlanned(c.key);
      }
    });
  }

  /** Capture stopping or switching streamer: decide open moments and cut what is pending now. */
  flush(): Promise<void> {
    return this.run(async () => {
      const closed = this.fusion.flush();
      if (closed) await this.handle(closed);
      for (const c of this.planner.pending()) await this.cutPlanned(c.key);
    });
  }

  reset(): void {
    this.fusion.reset();
    this.planner.reset();
    this.jobs.clear();
    this.clipIds.clear();
  }

  pendingCount(): number {
    return this.planner.pending().length;
  }

  private async cutPlanned(key: number): Promise<void> {
    this.planner.markCut(key);
    const job = this.jobs.get(key);
    if (!job) return;
    const clipId = await this.deps.cut(job).catch(() => null);
    if (clipId !== null) this.clipIds.set(key, clipId);
  }

  private async handle(m: FusedMoment): Promise<void> {
    this.deps.onDetection?.({ at: m.peakAt, reasons: m.reasons, score: m.score, clipped: m.clip });
    const target = this.target();
    if (!m.clip || !target) return; // provisional highlights (chat/viewers) stay as they are
    const decision = this.planner.plan(m);
    const c = decision.clip;
    const breakdown = {
      chat: m.intensities.chat,
      audio: m.intensities.audio,
      visual: m.intensities.visual,
      context: m.intensities.viewers,
      active_signals: m.kinds.map((k) => (k === "viewers" ? "context" : k)),
      fused: true,
    };
    if (decision.action === "new") {
      const strongest = m.kinds.reduce<SignalKind>((a, k) => ((m.intensities[k] ?? 0) > (m.intensities[a] ?? 0) ? k : a), m.kinds[0] ?? "audio");
      const h = await this.deps.createHighlight({
        streamer: { id: target.streamerId, display_name: target.displayName, username: target.username, platform: target.platform },
        session: target.sessionId ? { id: target.sessionId, broadcast_started_at: target.broadcastStartedAt } : null,
        origin: "capture",
        peakAt: m.peakAt,
        startAt: c.start,
        endAt: c.end,
        score: m.score,
        confidence: Math.min(0.95, 0.4 + 0.15 * m.kinds.length),
        category: CATEGORY[strongest],
        reasons: m.reasons,
        breakdown,
      });
      this.jobs.set(c.key, {
        key: c.key, target, highlightId: h.id, start: c.start, end: c.end, peakAt: m.peakAt, score: m.score,
        title: `${target.displayName} · ${m.reasons[0] ?? "Highlight"}`, reasons: m.reasons, kinds: m.kinds,
      });
    } else {
      const job = this.jobs.get(c.key);
      if (!job) return;
      job.end = c.end;
      job.score = c.score;
      job.peakAt = c.peakAt;
      job.reasons = dedupeReasons([...job.reasons, ...m.reasons]).slice(0, 8);
      job.kinds = [...new Set([...job.kinds, ...m.kinds])];
      await this.deps.updateHighlight(job.highlightId, { score: m.score, reasons: m.reasons, endAt: c.end, breakdown });
      const clipId = this.clipIds.get(c.key);
      if (decision.action === "merge" && clipId !== undefined) await this.deps.amendClip(clipId, job.reasons, job.score);
    }
    // Chat/viewer highlights that were fused into this clip are now part of it.
    for (const id of m.highlightIds) await this.deps.deleteHighlight(id).catch(() => undefined);
  }
}

function fusionConfig(o: CaptureOptions) {
  return { weights: o.weights, threshold: o.clipThreshold, quietMs: 10_000, maxMs: 60_000, minIntensity: 25 };
}
