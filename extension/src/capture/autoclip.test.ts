import { db } from "@/local/db";
import { createHighlight, deleteHighlight, listHighlights, updateHighlight } from "@/local/highlights";
import type { CaptureOptions, CaptureTarget } from "@/types/capture";
import { AutoClipper, type CutJob } from "./autoclip";

const T = Date.parse("2026-11-18T12:00:00Z");
const OPTS: CaptureOptions = { bufferSeconds: 120, preRollSeconds: 20, postRollSeconds: 20, maxClipSeconds: 90, clipThreshold: 40, weights: { audio: 25, chat: 30, visual: 20, viewers: 15, multi: 10 } };
const TARGET: CaptureTarget = { streamerId: 1, sessionId: null, platform: "twitch", displayName: "Alpha", username: "alpha", broadcastStartedAt: null, category: "Just Chatting" };

function clipper(target: CaptureTarget | null = TARGET) {
  const cuts: CutJob[] = [];
  const detections: { score: number; clipped: boolean }[] = [];
  const amended: number[] = [];
  const c = new AutoClipper(OPTS, () => target, {
    createHighlight, updateHighlight, deleteHighlight,
    cut: async (job) => {
      cuts.push({ ...job });
      return 100 + cuts.length;
    },
    amendClip: async (id) => void amended.push(id),
    onDetection: (d) => detections.push(d),
  });
  return { c, cuts, detections, amended };
}

describe("automatic clipping", () => {
  it("fuses audio + chat into one clip, merges the chat highlight into it, and waits for the post-roll", async () => {
    const chat = await createHighlight({ streamer: { id: 1, display_name: "Alpha", username: "alpha", platform: "twitch" }, session: null, origin: "chat",
      peakAt: T + 4000, startAt: T - 16_000, endAt: T + 26_000, score: 75, confidence: 0.8, category: "funny_moment", reasons: ["Chat is laughing"], breakdown: {} });
    const { c, cuts, detections } = clipper();
    await c.signal({ kind: "audio", at: T, intensity: 80, reasons: ["Laughter-like rhythmic bursts"] });
    await c.signal({ kind: "chat", at: T + 4000, start: T + 4000, end: T + 6000, intensity: 70, reasons: ["Chat is laughing"], highlightIds: [chat.id] });
    await c.tick(T + 10_000, T + 10_000);
    expect(detections).toEqual([]);
    await c.tick(T + 16_000, T + 16_000); // 10 s quiet → moment closed and planned
    expect(detections).toEqual([{ at: T, reasons: ["Laughter-like rhythmic bursts", "Chat is laughing"], score: 51, clipped: true }]);
    const hs = await listHighlights();
    expect(hs).toHaveLength(1); // the chat highlight was merged into the fused one
    expect(hs[0]).toMatchObject({ origin: "capture", score: 51, window_start_ms: T - 20_000, window_end_ms: T + 26_000, signal_breakdown: { audio: 80, chat: 70, fused: true } });
    await c.tick(T + 26_500, T + 25_000); // post-roll passed but the encoder isn't there yet
    expect(cuts).toEqual([]);
    await c.tick(T + 27_000, T + 27_000);
    expect(cuts).toEqual([expect.objectContaining({ highlightId: hs[0]!.id, start: T - 20_000, end: T + 26_000, kinds: ["audio", "chat"], title: "Alpha · Laughter-like rhythmic bursts" })]);
  });

  it("keeps a single-signal moment provisional (no clip) and never duplicates footage", async () => {
    const chat = await createHighlight({ streamer: { id: 1, display_name: "Alpha", username: "alpha", platform: "twitch" }, session: null, origin: "chat",
      peakAt: T, startAt: T, endAt: T, score: 80, confidence: 0.8, category: "x", reasons: ["Chat spike"], breakdown: {} });
    const { c, cuts, detections, amended } = clipper();
    await c.signal({ kind: "chat", at: T, intensity: 100, reasons: ["Chat spike"], highlightIds: [chat.id] });
    await c.tick(T + 11_000, T + 11_000);
    expect(detections.at(-1)).toMatchObject({ score: 30, clipped: false });
    expect((await listHighlights()).map((h) => h.id)).toEqual([chat.id]); // still there, still without video

    // Two overlapping moments → one longer clip; a late moment inside it → merged, not re-cut.
    await c.signal({ kind: "audio", at: T + 60_000, intensity: 90, reasons: ["Loud"] });
    await c.signal({ kind: "visual", at: T + 60_500, intensity: 90, reasons: ["Action"] });
    await c.tick(T + 71_000, T + 71_000);
    await c.signal({ kind: "audio", at: T + 75_000, intensity: 90, reasons: ["Shouting"] });
    await c.signal({ kind: "visual", at: T + 75_500, intensity: 90, reasons: ["Flash"] });
    await c.tick(T + 86_000, T + 86_000);
    await c.tick(T + 96_000, T + 96_000);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ start: T + 40_000, end: T + 95_500 });
    expect(cuts[0]!.reasons).toEqual(expect.arrayContaining(["Loud", "Action", "Shouting", "Flash"]));
    await c.signal({ kind: "audio", at: T + 90_000, intensity: 90, reasons: ["Cheer"] });
    await c.signal({ kind: "visual", at: T + 90_000, intensity: 90, reasons: ["Cut"] });
    await c.tick(T + 101_000, T + 101_000);
    expect(cuts).toHaveLength(1);
    expect(amended).toEqual([101]);
  });

  it("flushes pending clips when the capture stops, and does nothing without a target", async () => {
    const { c, cuts } = clipper();
    await c.signal({ kind: "audio", at: T, intensity: 90, reasons: ["Loud"] });
    await c.signal({ kind: "viewers", at: T, intensity: 90, reasons: ["Raid"] });
    await c.flush();
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.kinds).toEqual(["audio", "viewers"]);
    const none = clipper(null);
    await none.c.signal({ kind: "audio", at: T, intensity: 90, reasons: ["Loud"] });
    await none.c.signal({ kind: "visual", at: T, intensity: 90, reasons: ["Action"] });
    await none.c.flush();
    expect(none.cuts).toEqual([]);
    expect(await db.all("highlights")).toHaveLength(1);
  });
});
