import { calculateScore, Strictness, StreamAnalyzer, type CandidateDraft } from "./analyzer";
import * as lex from "./lexicon";
import type { ChatMessage } from "./window";
import { ChatSim } from "@/test/chat-sim";

function analyzer(languages = ["en", "es", "pt", "fr"], custom: string[] = []) {
  const a = new StreamAnalyzer("thestreamer");
  a.configure(languages, custom);
  return a;
}

function run(a: StreamAnalyzer, msgs: ChatMessage[], until: number): CandidateDraft[] {
  const sorted = [...msgs].sort((x, y) => x.at - y.at);
  const drafts: CandidateDraft[] = [];
  let i = 0;
  for (let t = sorted[0]?.at ?? until; t <= until; t += 5000) {
    while (i < sorted.length && sorted[i]!.at < t) a.add(sorted[i++]!);
    const d = a.evaluate(t);
    if (d) drafts.push(d);
  }
  const d = a.flush();
  if (d) drafts.push(d);
  return drafts;
}

describe("chat detection (ported from the backend)", () => {
  it("normal chat produces nothing", () => {
    const sim = new ChatSim();
    expect(run(analyzer(), sim.normal(600, 5), sim.now)).toEqual([]);
  });

  it("a single spammer is not an audience reaction", () => {
    const sim = new ChatSim();
    const msgs = [...sim.normal(120), ...sim.spam(20, "u3", "KEKW KEKW KEKW", 8), ...sim.normal(60)];
    expect(run(analyzer(), msgs, sim.now)).toEqual([]);
  });

  it("bots, commands and the broadcaster are ignored", () => {
    const sim = new ChatSim();
    const before = sim.normal(120);
    const noise: ChatMessage[] = [];
    for (let i = 0; i < 60; i++) {
      const t = sim.now + (i * 1000) / 3;
      noise.push(sim.msg("nightbot", "Follow the socials! clip it", [], t), sim.msg(`u${i}`, "!uptime", [], t), sim.msg("thestreamer", "lol", [], t));
    }
    sim.now += 20_000;
    expect(run(analyzer(), [...before, ...noise, ...sim.normal(60)], sim.now)).toEqual([]);
  });

  it("detects and explains a funny emote wave", () => {
    const sim = new ChatSim();
    const msgs = [...sim.normal(180), ...sim.burst(12, 40, "KEKW", ["KEKW"]), ...sim.normal(60)];
    const [d, ...rest] = run(analyzer(), msgs, sim.now);
    expect(rest).toEqual([]);
    expect(d!.category).toBe("funny_moment");
    expect(d!.score).toBeGreaterThanOrEqual(60);
    expect(Object.keys(d!.detectors)).toEqual(expect.arrayContaining(["chat_spike", "emote_wave"]));
    expect(d!.reasons.some((r) => r.includes("KEKW") && r.includes("chatters"))).toBe(true);
    expect(d!.reasons.some((r) => r.includes("normal level"))).toBe(true);
    expect(d!.strictness).toBe(Strictness.LOW);
    // The moment lies around the 12 s burst: the 15 s analysis window can add up to one window on each side.
    expect(d!.endAt - d!.startAt).toBeLessThanOrEqual(45_000);
  });

  it("detects clip requests", () => {
    const sim = new ChatSim();
    const [d] = run(analyzer(), [...sim.normal(180), ...sim.burst(10, 8, "CLIP IT"), ...sim.normal(60)], sim.now);
    expect(d!.detectors.clip_request).toBeDefined();
    expect(d!.reasons.some((r) => r.includes("asked to clip it"))).toBe(true);
  });

  it.each([
    ["NO WAY", ["en"], "unexpected_reaction"],
    ["jajajajaja", ["es"], "funny_moment"],
    ["kkkkkkkk", ["pt"], "funny_moment"],
    ["MDRRRR", ["fr"], "funny_moment"],
    ["LETS GOOOO", ["en"], "exciting_moment"],
  ])("multilingual reaction %s", (text, languages, category) => {
    const sim = new ChatSim();
    const wave = sim.wave((i) => text + "!".repeat(i % 3) + (i % 4 === 0 ? ` ${text.split(" ")[0]}` : ""), 30, 10);
    const drafts = run(analyzer(languages), [...sim.normal(180), ...wave, ...sim.normal(60)], sim.now);
    expect(drafts[0]?.category).toBe(category);
    expect(drafts[0]?.detectors.reaction).toBeDefined();
  });

  it("needs the language pack to call it funny", () => {
    const sim = new ChatSim();
    const wave = sim.wave((i) => `kkkk${"k".repeat(i % 5)} ${"rsrs".repeat(i % 2)}`, 30, 10);
    const drafts = run(analyzer(["en"]), [...sim.normal(180), ...wave, ...sim.normal(60)], sim.now);
    expect(drafts.every((d) => d.category !== "funny_moment")).toBe(true);
  });

  it("counts custom keywords as reactions", () => {
    const sim = new ChatSim();
    const wave = sim.wave((i) => `absolute cinema${"!".repeat(i % 3)}`, 25, 9);
    const drafts = run(analyzer(["en"], ["absolute cinema"]), [...sim.normal(180), ...wave, ...sim.normal(60)], sim.now);
    expect(drafts[0]?.reasons.some((r) => r.includes("using your keywords"))).toBe(true);
  });

  it("measures spikes against each stream's own baseline", () => {
    const quiet = new ChatSim(1);
    const busy = new ChatSim(2, 400);
    const q = [...quiet.normal(180, 2), ...quiet.burst(15, 30, "ok"), ...quiet.normal(30, 2)];
    expect(run(analyzer(), q, quiet.now).length).toBeGreaterThan(0);
    expect(run(analyzer(), busy.normal(240, 30), busy.now)).toEqual([]);
  });

  it("small reactions only for high sensitivity", () => {
    const sim = new ChatSim();
    const drafts = run(analyzer(), [...sim.normal(180, 3), ...sim.burst(15, 7, "omg"), ...sim.normal(60, 3)], sim.now);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.strictness < Strictness.LOW)).toBe(true);
  });

  it("merges two close waves and keeps separate moments separate", () => {
    let sim = new ChatSim();
    let drafts = run(analyzer(), [...sim.normal(180), ...sim.burst(8, 30, "KEKW", ["KEKW"]), ...sim.normal(4), ...sim.burst(8, 30, "CLIP IT"), ...sim.normal(90)], sim.now);
    expect(drafts).toHaveLength(1);
    expect(Object.keys(drafts[0]!.detectors)).toEqual(expect.arrayContaining(["emote_wave", "clip_request"]));

    sim = new ChatSim();
    drafts = run(analyzer(), [...sim.normal(180), ...sim.burst(10, 35, "KEKW", ["KEKW"]), ...sim.normal(150), ...sim.burst(10, 35, "NO WAY"), ...sim.normal(60)], sim.now);
    expect(drafts.map((d) => d.category)).toEqual(["funny_moment", "unexpected_reaction"]);
  });

  it("activity snapshot has no message content", () => {
    const sim = new ChatSim();
    const a = analyzer();
    sim.normal(120, 6).forEach((m) => a.add(m));
    const snap = a.activity(sim.now);
    expect(snap.messages_per_minute).toBeGreaterThan(0);
    expect(snap.warming_up).toBe(false);
    expect(snap.series).toHaveLength(36);
  });

  it("scores with renormalized weights and normalizes text like the backend", () => {
    expect(calculateScore({ chat: 80 })).toBe(80);
    expect(calculateScore({ chat: 80, audio: 40 })).toBeCloseTo((80 * 0.25 + 40 * 0.3) / 0.55);
    expect(calculateScore({})).toBe(0);
    const idx = lex.buildReactionIndex(["en", "es"], ["Big Brain"]);
    expect(lex.normalize("LOOOOOL!!!")).toBe("lol");
    expect([lex.normalize("jajajajaja"), lex.normalize("MDRRRR")]).toEqual(["jaja", "mdr"]);
    expect(lex.matchReactions(lex.normalize("NO WAAAY!!"), idx).has("shock")).toBe(true);
    expect(lex.matchReactions("big brain", idx)).toEqual(new Set(["custom"]));
    expect(lex.matchReactions("what time does the stream end today", idx).size).toBe(0);
    expect(lex.isClipRequest("clip it") && lex.isClipRequest("clip that pls")).toBe(true);
    expect(lex.isClipRequest("i was watching a clip yesterday from another stream")).toBe(false);
    expect(lex.normalize("هههههه")).toBe("ه"); // same as the backend
  });
});
