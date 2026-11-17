import type { ChatMessage } from "@/detection/window";

/** Deterministic chat simulator (seeded; no wall clock). Mirrors the original backend tests. */
export class ChatSim {
  now = Date.UTC(2026, 10, 15, 12, 0, 0);
  users: string[];
  private s: number;
  static FILLER = ["hi chat", "what game is this", "nice", "how long is stream", "first time here", "ok",
    "this music is good", "anyone else lagging", "gm", "true", "lmk when he plays ranked", "yo"];

  constructor(seed = 7, chatters = 120) {
    this.s = seed;
    this.users = Array.from({ length: chatters }, (_, i) => `u${i}`);
  }

  random(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.random() * xs.length)]!;
  }
  sample<T>(xs: T[], n: number): T[] {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, n);
  }
  msg(user: string, text: string, emotes: string[] = [], at = this.now): ChatMessage {
    return { userId: user, userLogin: user, text, emotes, at };
  }
  normal(seconds: number, per5s = 4): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let step = 0; step < seconds; step++) {
      const t = this.now + step * 1000;
      const n = Math.floor(per5s / 5) + (this.random() < (per5s / 5) % 1 ? 1 : 0);
      for (let k = 0; k < n; k++) out.push(this.msg(this.pick(this.users), this.pick(ChatSim.FILLER), [], t));
    }
    this.now += seconds * 1000;
    return out;
  }
  burst(seconds: number, users: number, text: string, emotes: string[] = []): ChatMessage[] {
    const crowd = this.sample(this.users, users);
    const out = crowd.map((u, i) => this.msg(u, text, emotes, this.now + (i * seconds * 1000) / users));
    this.now += seconds * 1000;
    return out;
  }
  spam(seconds: number, user: string, text: string, perSecond = 5): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let s = 0; s < seconds; s++) for (let k = 0; k < perSecond; k++) out.push(this.msg(user, text, [], this.now + s * 1000));
    this.now += seconds * 1000;
    return out;
  }
  wave(text: (i: number) => string, users: number, seconds: number): ChatMessage[] {
    const out = this.sample(this.users, users).map((u, i) => this.msg(u, text(i), [], this.now + (i * 1000) / 3));
    this.now += seconds * 1000;
    return out;
  }
}

