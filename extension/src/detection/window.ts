/**
 * Rolling chat window: 5-second buckets, per-user caps, per-stream baseline.
 * Only aggregates are kept (sets of user ids per emote / short phrase / reaction), and only for
 * the last few minutes, in memory. Message text is never stored.
 */
import * as lex from "./lexicon";

export const BUCKET_MS = 5_000;
export const WINDOW_BUCKETS = 3; // analysis window = 15 s
export const BASELINE_MS = 300_000; // 5 min of history defines "normal"
export const MIN_BASELINE_BUCKETS = 6;
export const PER_USER_CAP = 2;
const MAX_PHRASE_CHARS = 40;

export interface ChatMessage {
  userId: string;
  userLogin: string;
  text: string;
  /** Emote names used in the message (e.g. "KEKW"). */
  emotes: string[];
  /** Epoch ms (local clock when received). */
  at: number;
}

interface Bucket {
  start: number;
  raw: number;
  userMessages: Map<string, number>;
  emoteUsers: Map<string, Set<string>>;
  phraseUsers: Map<string, Set<string>>;
  reactionUsers: Map<string, Set<string>>;
  clipUsers: Set<string>;
}

const newBucket = (start: number): Bucket => ({
  start, raw: 0, userMessages: new Map(), emoteUsers: new Map(), phraseUsers: new Map(), reactionUsers: new Map(), clipUsers: new Set(),
});

const effective = (b: Bucket) => [...b.userMessages.values()].reduce((s, c) => s + Math.min(c, PER_USER_CAP), 0);

function addTo(map: Map<string, Set<string>>, key: string, uid: string) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(uid);
}

export interface WindowFeatures {
  start: number;
  end: number;
  effectiveMessages: number;
  rawMessages: number;
  uniqueUsers: number;
  emoteUsers: Map<string, number>;
  phraseUsers: Map<string, number>;
  phraseCategories: Map<string, string | null>;
  reactionUsers: Map<string, number>;
  clipRequesters: number;
  sentiment: number | null;
}

export interface Baseline {
  buckets: number;
  mean: number;
  std: number;
  perWindowEmoteUsers: Map<string, number>;
  perWindowPhraseUsers: Map<string, number>;
  perWindowReactionUsers: Map<string, number>;
  sentimentMean: number | null;
  ready: boolean;
}

const floor = (t: number) => t - (t % BUCKET_MS);

function sentiment(reactions: Map<string, number>): number | null {
  let pos = 0;
  let neg = 0;
  for (const [k, v] of reactions) {
    if (lex.POSITIVE.has(k)) pos += v;
    if (lex.NEGATIVE.has(k)) neg += v;
  }
  return pos + neg === 0 ? null : (pos - neg) / (pos + neg);
}

const sizes = (m: Map<string, Set<string>>) => new Map([...m].map(([k, v]) => [k, v.size]));

export class RollingChatWindow {
  private buckets: Bucket[] = [];
  private reactionIndex = lex.buildReactionIndex(["en"], []);
  private phraseCategory = new Map<string, string | null>();
  private readonly broadcasterLogin: string;

  constructor(broadcasterLogin = "") {
    this.broadcasterLogin = broadcasterLogin.toLowerCase();
  }

  configure(languages: Iterable<string>, customKeywords: Iterable<string>) {
    this.reactionIndex = lex.buildReactionIndex(languages, customKeywords);
    this.phraseCategory.clear();
  }

  private bucketFor(t: number): Bucket {
    const start = floor(t);
    const last = this.buckets.at(-1);
    if (last && start <= last.start) return last; // same bucket, or a late message
    const b = newBucket(start);
    this.buckets.push(b);
    return b;
  }

  add(m: ChatMessage): void {
    const b = this.bucketFor(m.at);
    b.raw += 1;
    const login = m.userLogin.toLowerCase();
    if (lex.KNOWN_BOTS.has(login) || login === this.broadcasterLogin || lex.isCommand(m.text)) return;
    const uid = m.userId;
    const n = (b.userMessages.get(uid) ?? 0) + 1;
    b.userMessages.set(uid, n);
    if (n > PER_USER_CAP) return;
    for (const e of new Set(m.emotes)) addTo(b.emoteUsers, e, uid);
    const norm = lex.normalize(m.text);
    if (!norm) return;
    const cats = lex.matchReactions(norm, this.reactionIndex);
    if (lex.hasInterrobang(m.text)) cats.add("shock");
    if (norm.length <= MAX_PHRASE_CHARS) {
      addTo(b.phraseUsers, norm, uid);
      if (!this.phraseCategory.has(norm) && this.phraseCategory.size < 5000)
        this.phraseCategory.set(norm, cats.size ? [...cats].sort()[0]! : null);
    }
    if (lex.isClipRequest(norm)) b.clipUsers.add(uid);
    for (const c of cats) addTo(b.reactionUsers, c, uid);
    for (const e of m.emotes) {
      const c = lex.EMOTE_CATEGORIES[e.toLowerCase()];
      if (c) addTo(b.reactionUsers, c, uid);
    }
  }

  prune(now: number): void {
    const cutoff = now - BASELINE_MS - WINDOW_BUCKETS * BUCKET_MS;
    while (this.buckets.length && this.buckets[0]!.start < cutoff) this.buckets.shift();
    if (this.phraseCategory.size >= 5000) this.phraseCategory.clear();
  }

  private filled(start: number, end: number): Bucket[] {
    const have = new Map(this.buckets.filter((b) => b.start >= start && b.start < end).map((b) => [b.start, b]));
    const out: Bucket[] = [];
    for (let t = start; t < end; t += BUCKET_MS) out.push(have.get(t) ?? newBucket(t));
    return out;
  }

  /** Window = the last 3 completed buckets before `now`; baseline = up to 5 min before that. */
  features(now: number): [WindowFeatures, Baseline] {
    const end = floor(now);
    const start = end - WINDOW_BUCKETS * BUCKET_MS;
    const win = this.filled(start, end);
    const users = new Set<string>();
    const clips = new Set<string>();
    const emotes = new Map<string, Set<string>>();
    const phrases = new Map<string, Set<string>>();
    const reactions = new Map<string, Set<string>>();
    for (const b of win) {
      b.userMessages.forEach((_v, u) => users.add(u));
      b.clipUsers.forEach((u) => clips.add(u));
      for (const [src, dst] of [[b.emoteUsers, emotes], [b.phraseUsers, phrases], [b.reactionUsers, reactions]] as const)
        for (const [k, v] of src) v.forEach((u) => addTo(dst, k, u));
    }
    const reactionSizes = sizes(reactions);
    const feats: WindowFeatures = {
      start,
      end,
      effectiveMessages: win.reduce((s, b) => s + effective(b), 0),
      rawMessages: win.reduce((s, b) => s + b.raw, 0),
      uniqueUsers: users.size,
      emoteUsers: sizes(emotes),
      phraseUsers: sizes(phrases),
      phraseCategories: new Map([...phrases.keys()].map((k) => [k, this.phraseCategory.get(k) ?? null])),
      reactionUsers: reactionSizes,
      clipRequesters: clips.size,
      sentiment: sentiment(reactionSizes),
    };

    const first = this.buckets[0]?.start ?? start;
    const baseStart = Math.max(first, start - BASELINE_MS);
    const hist = baseStart < start ? this.filled(baseStart, start) : [];
    const counts = hist.map(effective);
    const n = counts.length;
    const mean = n ? counts.reduce((a, b) => a + b, 0) / n : 0;
    const std = n ? Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / n) : 0;
    const windows = Math.max(1, n / WINDOW_BUCKETS);
    const totals = (pick: (b: Bucket) => Map<string, Set<string>>) => {
      const m = new Map<string, number>();
      for (const b of hist) for (const [k, v] of pick(b)) m.set(k, (m.get(k) ?? 0) + v.size);
      return new Map([...m].map(([k, v]) => [k, v / windows]));
    };
    const sentiments = hist.map((b) => sentiment(sizes(b.reactionUsers))).filter((x): x is number => x !== null);
    return [
      feats,
      {
        buckets: n,
        mean,
        std,
        perWindowEmoteUsers: totals((b) => b.emoteUsers),
        perWindowPhraseUsers: totals((b) => b.phraseUsers),
        perWindowReactionUsers: totals((b) => b.reactionUsers),
        sentimentMean: sentiments.length ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length : null,
        ready: n >= MIN_BASELINE_BUCKETS,
      },
    ];
  }

  /** Summary for the Live Monitoring view (no message content). */
  activity(now: number, buckets = 36) {
    const end = floor(now);
    const recent = this.filled(end - buckets * BUCKET_MS, end);
    const lastMin = recent.slice(-12);
    const [, base] = this.features(now);
    const chatters = new Set<string>();
    lastMin.forEach((b) => b.userMessages.forEach((_v, u) => chatters.add(u)));
    return {
      bucket_seconds: BUCKET_MS / 1000,
      messages_per_minute: lastMin.reduce((s, b) => s + b.raw, 0),
      unique_chatters_per_minute: chatters.size,
      baseline_messages_per_minute: Math.round(base.mean * (60_000 / BUCKET_MS) * 10) / 10,
      warming_up: !base.ready,
      series: recent.map((b) => b.raw),
    };
  }
}
