/**
 * Per-stream chat analyzer: window → detectors → moments → candidate drafts.
 * Same rules as the original backend detectors (relative to each stream's own baseline, anti-spam,
 * minimum distinct chatters, three sensitivity levels).
 */
import { EMOTE_CATEGORIES } from "./lexicon";
import { RollingChatWindow, WINDOW_BUCKETS, type Baseline, type ChatMessage, type WindowFeatures } from "./window";

export enum Strictness {
  HIGH = 1, // most permissive thresholds
  MEDIUM = 2,
  LOW = 3, // strictest thresholds
}

export function strictnessFor(sensitivity: string): Strictness {
  return ({ high: Strictness.HIGH, medium: Strictness.MEDIUM, low: Strictness.LOW } as Record<string, Strictness>)[sensitivity] ?? Strictness.MEDIUM;
}

interface Thresholds {
  z: number;
  ratio: number;
  minUsers: number;
  share: number;
}

const THRESHOLDS: Record<Strictness, Thresholds> = {
  [Strictness.HIGH]: { z: 1.8, ratio: 1.6, minUsers: 3, share: 0.2 },
  [Strictness.MEDIUM]: { z: 2.5, ratio: 2.0, minUsers: 5, share: 0.3 },
  [Strictness.LOW]: { z: 3.5, ratio: 2.8, minUsers: 8, share: 0.4 },
};

function strictest(passes: (t: Thresholds) => boolean): Strictness | null {
  for (const level of [Strictness.LOW, Strictness.MEDIUM, Strictness.HIGH]) if (passes(THRESHOLDS[level])) return level;
  return null;
}

export interface DetectorEvent {
  type: "chat_spike" | "emote_wave" | "repeated_phrase" | "clip_request" | "reaction" | "sentiment_shift";
  at: number;
  windowStart: number;
  confidence: number;
  score: number;
  strictness: Strictness;
  reason: string;
  hint: string | null;
  metadata: Record<string, unknown>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const argmax = (m: Map<string, number>): [string, number] | null => {
  let best: [string, number] | null = null;
  for (const e of m) if (!best || e[1] > best[1]) best = e;
  return best;
};

type Detector = (f: WindowFeatures, b: Baseline) => DetectorEvent[];

const chatSpike: Detector = (f, base) => {
  if (!base.ready) return [];
  const perBucket = f.effectiveMessages / WINDOW_BUCKETS;
  const spread = Math.max(base.std, Math.sqrt(base.mean), 1);
  const z = (perBucket - base.mean) / spread;
  const ratio = perBucket / Math.max(base.mean, 0.5);
  const level = strictest((t) => z >= t.z && ratio >= t.ratio && f.uniqueUsers >= t.minUsers);
  if (level === null) return [];
  return [{
    type: "chat_spike", at: f.end, windowStart: f.start, strictness: level, hint: null,
    score: r1(Math.min(100, 35 + 10 * (ratio - 1) + 4 * z + Math.min(15, f.uniqueUsers / 4))),
    confidence: r3(Math.min(0.99, 1 - Math.exp(-Math.max(0, z) / 3))),
    reason: `Chat activity ${ratio.toFixed(1)}× its normal level (${f.uniqueUsers} chatters in 15 s)`,
    metadata: { unique_users: f.uniqueUsers, ratio: r1(ratio), z: r1(z) },
  }];
};

const emotes: Detector = (f, base) => {
  const out: DetectorEvent[] = [];
  if (f.uniqueUsers === 0) return out;
  const top = argmax(f.emoteUsers);
  if (top) {
    const [emote, users] = top;
    const share = users / f.uniqueUsers;
    const usual = base.perWindowEmoteUsers.get(emote) ?? 0;
    const level = strictest((t) => users >= t.minUsers && share >= t.share && users >= 2 * usual + 1);
    if (level !== null)
      out.push({
        type: "emote_wave", at: f.end, windowStart: f.start, strictness: level,
        confidence: r3(Math.min(0.97, 0.4 + share * 0.6)), score: r1(Math.min(100, 30 + users * 2 + share * 30)),
        reason: `'${emote}' used by ${users} chatters (${pct(share)} of chat)`, hint: EMOTE_CATEGORIES[emote.toLowerCase()] ?? null,
        metadata: { emote, users, share: r1(share) },
      });
  }
  const emoteNames = new Set([...f.emoteUsers.keys()].map((e) => e.toLowerCase()));
  const phrases = new Map([...f.phraseUsers].filter(([p]) => !p.split(" ").every((w) => emoteNames.has(w))));
  const topPhrase = argmax(phrases);
  if (topPhrase) {
    const [phrase, users] = topPhrase;
    const share = users / f.uniqueUsers;
    const usual = base.perWindowPhraseUsers.get(phrase) ?? 0;
    const level = strictest((t) => users >= t.minUsers && share >= t.share && phrase.length >= 2 && users >= 2 * usual + 2);
    if (level !== null) {
      const hint = f.phraseCategories.get(phrase) ?? null;
      out.push({
        type: "repeated_phrase", at: f.end, windowStart: f.start, strictness: level,
        confidence: r3(Math.min(0.95, 0.35 + share * 0.6)), score: r1(Math.min(100, 25 + users * 2 + share * 25)),
        reason: `${users} chatters posted the same message`, hint: hint === "custom" ? null : hint,
        metadata: { users, share: r1(share) },
      });
    }
  }
  return out;
};

const clipRequests: Detector = (f) => {
  const n = f.clipRequesters;
  const level = strictest((t) => n >= Math.max(2, Math.floor(t.minUsers / 2)));
  if (level === null) return [];
  return [{
    type: "clip_request", at: f.end, windowStart: f.start, strictness: level, hint: null,
    confidence: r3(Math.min(0.98, 0.55 + 0.08 * n)), score: r1(Math.min(100, 45 + 7 * n)),
    reason: `${n} chatters asked to clip it`, metadata: { clip_requests: n },
  }];
};

const LABEL: Record<string, string> = { funny: "laughing", shock: "shocked", hype: "hyped", sad: "sad", custom: "using your keywords" };

const reactions: Detector = (f, base) => {
  const out: DetectorEvent[] = [];
  const top = argmax(f.reactionUsers);
  if (f.uniqueUsers === 0 || !top) return out;
  const [category, users] = top;
  const share = users / f.uniqueUsers;
  const usual = base.perWindowReactionUsers.get(category) ?? 0;
  const level = strictest((t) => users >= t.minUsers && share >= t.share && users >= 2 * usual + 1);
  if (level !== null)
    out.push({
      type: "reaction", at: f.end, windowStart: f.start, strictness: level,
      confidence: r3(Math.min(0.95, 0.4 + share * 0.55)), score: r1(Math.min(100, 30 + users * 2.2 + share * 30)),
      reason: `${users} chatters ${LABEL[category] ?? "reacting"} (${pct(share)} of chat)`, hint: category === "custom" ? null : category,
      metadata: { reaction: category, users, share: r1(share) },
    });
  const reacting = [...f.reactionUsers.values()].reduce((a, b) => a + b, 0);
  if (f.sentiment !== null && base.sentimentMean !== null && base.ready) {
    const delta = f.sentiment - base.sentimentMean;
    const lvl = strictest((t) => Math.abs(delta) >= 0.4 + t.share && reacting >= t.minUsers);
    if (lvl !== null)
      out.push({
        type: "sentiment_shift", at: f.end, windowStart: f.start, strictness: lvl,
        confidence: r3(Math.min(0.9, 0.3 + Math.abs(delta) / 2)), score: r1(Math.min(100, 25 + Math.abs(delta) * 40)),
        reason: `Chat mood turned ${delta > 0 ? "positive" : "negative"} suddenly`, hint: delta > 0 ? "hype" : "sad",
        metadata: { sentiment: r1(f.sentiment) },
      });
  }
  return out;
};

// --- scoring -------------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = { chat: 0.25, audio: 0.3, visual: 0.2, context: 0.25 } as const;
export type Signals = Partial<Record<keyof typeof DEFAULT_WEIGHTS, number | null>>;

/** Weighted mean over the signals that are actually available (missing ones are not zeros). */
export function calculateScore(signals: Signals): number {
  let total = 0;
  let sum = 0;
  for (const [k, w] of Object.entries(DEFAULT_WEIGHTS)) {
    const v = signals[k as keyof Signals];
    if (v === null || v === undefined) continue;
    total += w;
    sum += v * w;
  }
  return total ? sum / total : 0;
}

function chatSignal(events: DetectorEvent[]): [number, number] {
  const best = new Map<string, DetectorEvent>();
  for (const e of events) if (!best.has(e.type) || e.score > best.get(e.type)!.score) best.set(e.type, e);
  if (best.size === 0) return [0, 0];
  const scores = [...best.values()].map((e) => e.score).sort((a, b) => b - a);
  const score = Math.min(100, scores[0]! + 6 * (scores.length - 1));
  let miss = 1;
  for (const e of best.values()) miss *= 1 - e.confidence;
  return [r1(score), r3(Math.min(0.99, 1 - miss))];
}

const HINT_TO_CATEGORY: Record<string, string> = {
  funny: "funny_moment", shock: "unexpected_reaction", hype: "exciting_moment", sad: "emotional_moment",
};

export function inferCategory(events: DetectorEvent[]): string {
  const votes = new Map<string, number>();
  for (const e of events) {
    const c = e.hint ? HINT_TO_CATEGORY[e.hint] : undefined;
    if (c) votes.set(c, (votes.get(c) ?? 0) + e.score);
  }
  const top = argmax(votes);
  if (top && top[1] >= 40) return top[0];
  if (events.some((e) => ["chat_spike", "clip_request", "emote_wave", "repeated_phrase"].includes(e.type))) return "audience_reaction";
  return "unknown";
}

// --- moments -------------------------------------------------------------------------------
const QUIET_MS = 10_000;
const MAX_MOMENT_MS = 90_000;
const COOLDOWN_MS = 20_000;
export const MIN_SCORE = 35;
const PRIMARY = new Set(["chat_spike", "emote_wave", "clip_request", "reaction"]);

export interface CandidateDraft {
  startAt: number;
  endAt: number;
  peakAt: number;
  score: number;
  confidence: number;
  category: string;
  reasons: string[];
  strictness: Strictness;
  chat: number;
  detectors: Record<string, { max_score: number; windows: number }>;
}

function finish(events: DetectorEvent[], start: number): CandidateDraft | null {
  if (!events.some((e) => PRIMARY.has(e.type))) return null;
  const [chat, confidence] = chatSignal(events);
  const score = calculateScore({ chat });
  if (score < MIN_SCORE) return null;
  const best = new Map<string, DetectorEvent>();
  for (const e of events) if (!best.has(e.type) || e.score > best.get(e.type)!.score) best.set(e.type, e);
  const detectors: CandidateDraft["detectors"] = {};
  for (const e of events) {
    const d = (detectors[e.type] ??= { max_score: 0, windows: 0 });
    d.max_score = Math.max(d.max_score, e.score);
    d.windows += 1;
  }
  const peak = events.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    startAt: start,
    endAt: Math.max(...events.map((e) => e.at)),
    peakAt: peak.at,
    score: r1(score),
    confidence,
    category: inferCategory(events),
    reasons: [...best.values()].sort((a, b) => b.score - a.score).map((e) => e.reason),
    strictness: Math.max(...events.filter((e) => PRIMARY.has(e.type)).map((e) => e.strictness)) as Strictness,
    chat,
    detectors,
  };
}

export class StreamAnalyzer {
  readonly window: RollingChatWindow;
  lastEvents: DetectorEvent[] = [];
  messagesSeen = 0;
  private moment: { start: number; last: number; events: DetectorEvent[] } | null = null;
  private cooldownUntil = 0;

  constructor(broadcasterLogin = "") {
    this.window = new RollingChatWindow(broadcasterLogin);
  }

  configure(languages: Iterable<string>, customKeywords: Iterable<string>) {
    this.window.configure(languages, customKeywords);
  }

  add(m: ChatMessage) {
    this.messagesSeen += 1;
    this.window.add(m);
  }

  /** Call once per bucket (every 5 s). Returns a finished candidate, if any. */
  evaluate(now: number): CandidateDraft | null {
    const [f, base] = this.window.features(now);
    const events = [chatSpike, emotes, clipRequests, reactions].flatMap((d) => d(f, base));
    this.lastEvents = events;
    let draft: CandidateDraft | null = null;
    const m = this.moment;
    if (m && (now - m.last > QUIET_MS || now - m.start > MAX_MOMENT_MS)) {
      draft = finish(m.events, m.start);
      this.moment = null;
      this.cooldownUntil = now + COOLDOWN_MS;
    }
    if (events.length) {
      if (this.moment === null) {
        if (!(now < this.cooldownUntil && draft === null)) this.moment = { start: Math.min(...events.map((e) => e.windowStart)), last: now, events: [...events] };
      } else {
        this.moment.events.push(...events);
        this.moment.last = now;
      }
    }
    this.window.prune(now);
    return draft;
  }

  flush(): CandidateDraft | null {
    const m = this.moment;
    this.moment = null;
    return m ? finish(m.events, m.start) : null;
  }

  activity(now: number) {
    return { ...this.window.activity(now), active_signals: [...new Set(this.lastEvents.map((e) => e.type))].sort(), messages_seen: this.messagesSeen };
  }
}
