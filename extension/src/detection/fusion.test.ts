import { ClipPlanner, DEFAULT_FUSION, FusionEngine, fusedScore, type Signal } from "./fusion";

const T = 1_000_000;
const sig = (kind: Signal["kind"], at: number, intensity: number, reason = `${kind} ${intensity}`, extra: Partial<Signal> = {}): Signal => ({ kind, at, intensity, reasons: [reason], ...extra });

describe("fusion scoring", () => {
  it("adds weighted signals and a bonus when several kinds fire together", () => {
    expect(fusedScore({ audio: 100 }, DEFAULT_FUSION)).toBe(25);
    expect(fusedScore({ chat: 100 }, DEFAULT_FUSION)).toBe(30);
    expect(fusedScore({ audio: 100, chat: 100, visual: 100, viewers: 100 }, DEFAULT_FUSION)).toBe(100);
    expect(fusedScore({ audio: 80, chat: 60 }, DEFAULT_FUSION)).toBe(20 + 18 + 10);
    expect(fusedScore({ audio: 80, chat: 10 }, DEFAULT_FUSION)).toBe(20); // too weak to count, no bonus
  });

  it("never clips on one signal with the default weights, however strong", () => {
    const f = new FusionEngine();
    f.add(sig("audio", T, 100));
    f.add(sig("audio", T + 2000, 100));
    const m = f.poll(T + 20_000)!;
    expect(m).toMatchObject({ score: 25, kinds: ["audio"], clip: false });
  });

  it("is configurable: weights and threshold", () => {
    const f = new FusionEngine({ ...DEFAULT_FUSION, weights: { ...DEFAULT_FUSION.weights, audio: 60 }, threshold: 50 });
    f.add(sig("audio", T, 100));
    expect(f.poll(T + 20_000)).toMatchObject({ score: 60, clip: true });
  });

  it("groups signals of one moment (chat arrives late) and splits separate moments", () => {
    const f = new FusionEngine();
    expect(f.add(sig("audio", T, 80, "Loud"))).toBeNull();
    expect(f.add(sig("visual", T + 1000, 60, "Action"))).toBeNull();
    expect(f.add(sig("chat", T + 7000, 70, "Chat spike", { start: T + 4000, end: T + 9000, highlightIds: [7] }))).toBeNull();
    expect(f.poll(T + 15_000)).toBeNull(); // still within 10 s of the last signal
    const m = f.poll(T + 17_000)!;
    expect(m).toMatchObject({ start: T, end: T + 9000, peakAt: T, kinds: ["audio", "chat", "visual"], highlightIds: [7], clip: true });
    expect(m.score).toBe(Math.round(20 + 21 + 12 + 10));
    expect(m.reasons).toEqual(["Loud", "Chat spike", "Action"]);

    f.add(sig("audio", T + 100_000, 50));
    const closed = f.add(sig("chat", T + 130_000, 50)); // 30 s later: a new moment
    expect(closed).toMatchObject({ kinds: ["audio"], clip: false });
  });

  it("caps a moment's length", () => {
    const f = new FusionEngine();
    for (let i = 0; i < 20; i++) expect(f.add(sig("audio", T + i * 5000, 60))?.end ?? null).toBe(i === 13 ? T + 60_000 : null);
  });
});

describe("clip planning (overlaps and duplicates)", () => {
  it("adds pre/post roll, extends a clip still waiting for its post-roll, merges into a cut clip", () => {
    const p = new ClipPlanner(20_000, 20_000, 90_000);
    const a = p.plan({ start: T, end: T + 5000, peakAt: T, score: 50 });
    expect(a).toMatchObject({ action: "new", clip: { start: T - 20_000, end: T + 25_000 } });
    const b = p.plan({ start: T + 15_000, end: T + 18_000, peakAt: T + 16_000, score: 70 });
    expect(b).toMatchObject({ action: "extend", clip: { key: a.clip.key, start: T - 20_000, end: T + 38_000, score: 70, peakAt: T + 16_000 } });
    expect(p.due(T + 30_000)).toEqual([]);
    expect(p.due(T + 38_000).map((c) => c.key)).toEqual([a.clip.key]);
    p.markCut(a.clip.key);
    // A late moment inside the footage that was already saved: no second clip.
    expect(p.plan({ start: T + 30_000, end: T + 31_000, peakAt: T + 30_000, score: 90 })).toMatchObject({ action: "merge", clip: { key: a.clip.key, score: 90 } });
    // Just after it: a new clip that starts where the saved one ended (no duplicate footage).
    const c = p.plan({ start: T + 45_000, end: T + 46_000, peakAt: T + 45_000, score: 60 });
    expect(c).toMatchObject({ action: "new", clip: { start: T + 38_000, end: T + 66_000 } });
  });

  it("never grows a clip past the maximum length", () => {
    const p = new ClipPlanner(20_000, 20_000, 60_000);
    const a = p.plan({ start: T, end: T, peakAt: T, score: 50 });
    const b = p.plan({ start: T + 25_000, end: T + 25_000, peakAt: T + 25_000, score: 50 }); // would make 85 s
    expect(b.action).toBe("new");
    expect(b.clip.key).not.toBe(a.clip.key);
    expect(b.clip.start).toBe(T + 20_000);
    expect(p.plan({ start: T, end: T + 100_000, peakAt: T, score: 50 }).clip.end - p.pending().at(-1)!.start).toBeLessThanOrEqual(60_000);
  });
});
