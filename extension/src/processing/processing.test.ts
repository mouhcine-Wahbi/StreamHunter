/**
 * 3.0 phase 5: output geometry, action following, moments, the asset queue and the rights gates.
 * The WebCodecs encode itself needs a real browser; it's checked in real Chrome (see
 * IMPLEMENTATION_STATUS.md), not here.
 */
import { db } from "@/local/db";
import { listAssets, nextQueuedAsset, patchAsset, queueAssets, MAX_ATTEMPTS } from "@/local/assets";
import { addSource, requestAnalysis, requestSourceClip } from "@/local/sources";
import { RightsError } from "@/local/rights";
import { deleteClip, saveClip } from "@/local/clips";
import { createProcessingManager } from "@/background/processing-manager";
import { getSettings, updateSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import { ActionTracker, columnEnergy, cropFor, planLandscape, planVertical, resolveLayout, xProblems } from "./layout";
import { findMoments } from "./moments";
import { sampleRange } from "./transcode";

const inside = (d: { sx: number; sy: number; sw: number; sh: number }, w: number, h: number) => d.sx >= 0 && d.sy >= 0 && d.sx + d.sw <= w && d.sy + d.sh <= h;

describe("vertical and landscape geometry", () => {
  it("centre crop is a full-height 9:16 window in the middle of a 16:9 frame", () => {
    const p = planVertical(1920, 1080, { kind: "center" });
    expect(p).toMatchObject({ width: 1080, height: 1920, used: "center" });
    const d = p.draws[0]!;
    expect(d.sh).toBe(1080);
    expect(d.sw).toBe(608); // 1080 × 9/16
    expect(d.sx).toBe(Math.round((1920 - 608) / 2));
    expect(d).toMatchObject({ dx: 0, dy: 0, dw: 1080, dh: 1920 });
  });

  it("follow the action moves the window but never leaves the frame", () => {
    for (const x of [0, 0.2, 0.5, 0.9, 1]) {
      const d = planVertical(1920, 1080, { kind: "action" }, x).draws[0]!;
      expect(inside(d, 1920, 1080)).toBe(true);
    }
    expect(planVertical(1920, 1080, { kind: "action" }, 1).draws[0]!.sx).toBe(1920 - 608); // flush with the right edge
    expect(planVertical(1920, 1080, { kind: "action" }, 0).draws[0]!.sx).toBe(0);
  });

  it("facecam above gameplay: the facecam fills the width on top (≤ 40% of the height), gameplay below, nothing outside the frame", () => {
    const p = planVertical(1920, 1080, { kind: "facecam_top", facecam: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 } });
    expect(p.used).toBe("facecam_top");
    const [cam, game] = p.draws;
    expect(cam!.dy).toBe(0);
    expect(cam!.dh).toBeLessThanOrEqual(Math.round(1920 * 0.4));
    expect(cam!.dh % 2).toBe(0);
    expect(game!.dy).toBe(cam!.dh);
    expect(game!.dy + game!.dh).toBe(1920);
    expect(inside(cam!, 1920, 1080) && inside(game!, 1920, 1080)).toBe(true);
    // The facecam's own aspect is kept (no stretching): sw/sh ≈ dw/dh.
    expect(Math.abs(cam!.sw / cam!.sh - cam!.dw / cam!.dh)).toBeLessThan(0.02);
    expect(Math.abs(game!.sw / game!.sh - game!.dw / game!.dh)).toBeLessThan(0.02);
  });

  it("a tall facecam is cropped, not squeezed, to stay within 40%", () => {
    const p = planVertical(1920, 1080, { kind: "facecam_top", facecam: { x: 0, y: 0, w: 0.2, h: 0.6 } });
    const cam = p.draws[0]!;
    expect(cam.dh).toBe(768);
    expect(Math.abs(cam.sw / cam.sh - 1080 / 768)).toBeLessThan(0.02);
  });

  it("facecam layout without a facecam position falls back to centre, and says so", () => {
    const p = planVertical(1920, 1080, { kind: "facecam_top", facecam: null });
    expect(p.used).toBe("center");
    expect(p.notes[0]).toMatch(/No facecam position/);
  });

  it("portrait or narrow sources still produce a valid crop", () => {
    const d = cropFor(720, 1280, 1080 / 1920);
    expect(d).toMatchObject({ sw: 720, sx: 0 });
    expect(inside(d, 720, 1280)).toBe(true);
  });

  it("landscape for X: scaled down to fit 1920×1200, never up, even sizes", () => {
    expect(planLandscape(2560, 1440)).toMatchObject({ width: 1920, height: 1080 });
    expect(planLandscape(1280, 720)).toMatchObject({ width: 1280, height: 720 });
    expect(planLandscape(1921, 1081).width % 2).toBe(0);
  });

  it("an original clip is reused for X only when it already meets every limit", () => {
    const ok = { durationSec: 60, width: 1920, height: 1080, videoCodec: "avc1.64002a", audioCodec: "mp4a.40.2", sizeBytes: 50e6 };
    expect(xProblems(ok)).toEqual([]);
    expect(xProblems({ ...ok, durationSec: 170 })).toEqual(["longer than 140 s"]);
    expect(xProblems({ ...ok, audioCodec: "Opus" })).toEqual(["audio isn't AAC"]);
    expect(xProblems({ ...ok, width: 2560, height: 1440 })).toEqual(["larger than 1920×1200"]);
  });
});

describe("following the action", () => {
  const cols = (center: number, n = 32) => Array.from({ length: n }, (_, i) => (Math.abs((i + 0.5) / n - center) < 0.08 ? 100 : 0));

  it("starts where the motion is, then glides with a speed limit", () => {
    const t = new ActionTracker();
    expect(t.update(cols(0.3))).toBeCloseTo(0.3, 1);
    const before = t.position;
    const after = t.update(cols(0.9));
    expect(after - before).toBeGreaterThan(0);
    expect(after - before).toBeLessThanOrEqual(0.0121);
    for (let i = 0; i < 300; i++) t.update(cols(0.9));
    expect(t.position).toBeGreaterThan(0.8);
  });

  it("ignores small moves, no motion, and motion spread over the whole frame", () => {
    const t = new ActionTracker();
    t.update(cols(0.5));
    // A small shift that then stays put: followed smoothly, no overshoot, then held still.
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) seen.push(t.update(cols(0.53)));
    expect(Math.max(...seen)).toBeLessThan(0.545);
    const settled = t.position;
    for (let i = 0; i < 30; i++) t.update(cols(0.53));
    expect(t.position).toBe(settled);
    expect(t.update(new Array(32).fill(0))).toBe(settled);
    expect(t.update(new Array(32).fill(10))).toBe(settled); // camera pan / cut: everything changes
  });

  it("measures motion per column from two frames", () => {
    const a = new Uint8Array(8 * 2);
    const b = Uint8Array.from(a);
    b[6] = 200; // row 0, column 6
    b[14] = 200; // row 1, column 6
    const e = columnEnergy(a, b, 8, 2);
    expect(e[6]).toBe(400);
    expect([...e].filter((x) => x > 0)).toHaveLength(1);
  });
});

describe("suggested moments in an authorized file", () => {
  it("finds the loud, busy parts relative to the file itself, without overlaps, in time order", () => {
    const n = 300;
    const loud = Array.from({ length: n }, (_, i) => (i >= 100 && i <= 104 ? -8 : i >= 220 && i <= 223 ? -10 : -30 + Math.sin(i) * 2));
    const vis = Array.from({ length: n }, (_, i) => (i >= 101 && i <= 103 ? 60 : 8));
    const m = findMoments(loud, vis, n);
    expect(m.length).toBe(2);
    expect(m[0]!.at).toBeGreaterThanOrEqual(99);
    expect(m[0]!.at).toBeLessThanOrEqual(105);
    expect(m[0]!.kinds).toEqual(["audio", "visual"]);
    expect(m[0]!.reasons[0]).toMatch(/^Louder than \d+% of this video$/);
    expect(m[0]!.end - m[0]!.start).toBe(30);
    expect(m[1]!.start).toBeGreaterThanOrEqual(m[0]!.end);
  });

  it("finds nothing in a flat file, and works without audio", () => {
    expect(findMoments(new Array(200).fill(-20), new Array(200).fill(5), 200)).toEqual([]);
    const vis = Array.from({ length: 120 }, (_, i) => (i === 60 ? 90 : 5));
    const m = findMoments(new Array(120).fill(-90), vis, 120);
    expect(m).toHaveLength(1);
    expect(m[0]!.kinds).toEqual(["visual"]);
  });
});

describe("decode range", () => {
  const s = (sec: number, key: boolean) => ({ cts: sec * 1000, timescale: 1000, is_sync: key });
  it("starts at the keyframe before the start and stops at the keyframe after the end", () => {
    const samples = Array.from({ length: 10 }, (_, i) => s(i, i % 4 === 0)); // keys at 0, 4, 8
    expect(sampleRange(samples, 5_000_000, 6_500_000)).toEqual([4, 8]);
    expect(sampleRange(samples, 0, 3_000_000)).toEqual([0, 4]);
    expect(sampleRange(samples, 8_500_000, 20_000_000)).toEqual([8, 10]);
  });
});

describe("layout choice", () => {
  const face = { x: 0.7, y: 0.7, w: 0.3, h: 0.3 };
  it("clip override → creator → default; the default facecam uses the creator's facecam", () => {
    expect(resolveLayout({ kind: "center" }, { kind: "action" }, "facecam_top")).toEqual({ layout: { kind: "center" }, source: "clip" });
    expect(resolveLayout(null, { kind: "action", facecam: null }, "center")).toEqual({ layout: { kind: "action", facecam: null }, source: "creator" });
    expect(resolveLayout(null, null, "facecam_top")).toEqual({ layout: { kind: "facecam_top", facecam: null }, source: "default" });
    expect(resolveLayout({ kind: "facecam_top" }, { kind: "center", facecam: face }, "center").layout.facecam).toEqual(face);
  });
});

describe("asset queue", () => {
  const blob = () => new Blob([new Uint8Array(10)], { type: "video/mp4" });
  async function clip(streamerId = 0) {
    return saveClip({ candidateId: 0, sessionId: null, streamerId, streamerName: "S", platform: "twitch", title: "t", startedAt: Date.now(), durationSec: 30, width: 1920, height: 1080, score: 70, blob: blob() });
  }

  it("queues one asset per format, replaces older versions, retries an interrupted one once, and is deleted with its clip", async () => {
    const c = await clip();
    const [v1] = await queueAssets(c.id, ["vertical"], { layout: { kind: "center" }, source: "default" });
    const [v2, l] = await queueAssets(c.id, ["vertical", "landscape"], { layout: { kind: "action" }, source: "clip" });
    expect((await listAssets(c.id)).map((a) => a.id)).toEqual([v2!.id, l!.id]);
    expect(v1!.id).not.toBe(v2!.id);
    expect(l!.layout).toBeNull();
    await patchAsset(v2!.id, { status: "processing" });
    expect((await nextQueuedAsset())!.id).toBe(v2!.id); // interrupted → queued again
    for (let i = 0; i < MAX_ATTEMPTS; i++) await patchAsset(v2!.id, { status: "processing" }).then(() => nextQueuedAsset());
    expect((await listAssets(c.id)).find((a) => a.id === v2!.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    await deleteClip(c.id);
    expect(await listAssets(c.id)).toEqual([]);
  });

  it("the worker makes the formats chosen in Settings with the creator's layout, and wakes the queue", async () => {
    const s = await db.put<Streamer>("streamers", { id: undefined as unknown as number, platform: "twitch", platform_user_id: "1", login: "s", display_name: "S", layout: { kind: "facecam_top", facecam: { x: 0, y: 0, w: 0.3, h: 0.3 } } } as unknown as Streamer);
    const c = await clip(s.id);
    let kicks = 0;
    const m = createProcessingManager({ ensureOffscreen: async () => undefined, kick: async () => void kicks++, closeIfIdle: async () => undefined });
    await updateSettings({ formats: { landscape: false } });
    await m.onClipSaved(c.id, await getSettings());
    const assets = await listAssets(c.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "vertical", layout: { kind: "facecam_top" }, layout_source: "creator", status: "queued" });
    expect(kicks).toBe(1);
    await updateSettings({ formats: { vertical: false } });
    await m.onClipSaved(c.id, await getSettings());
    expect(kicks).toBe(1); // nothing to make
    await expect(m.makeAssets(9999, await getSettings(), ["vertical"])).rejects.toThrow(/no longer exists/);
  });
});

describe("rights gates for authorized files", () => {
  const file = () => Object.assign(new Blob([new Uint8Array(100)], { type: "video/mp4" }), { name: "a.mp4" });
  it("analysis needs analysis rights; cutting needs processing rights and 3–180 s", async () => {
    const a = await addSource(file(), { creator_name: "C" }, { status: "analysis", evidence: "my own channel", confirmed: true });
    expect((await requestAnalysis(a.id)).analysis).toBe("queued");
    await expect(requestSourceClip(a.id, { start: 0, end: 30 })).rejects.toThrow(RightsError);
    const p = await addSource(file(), { creator_name: "C" }, { status: "processing", evidence: "licence #42", confirmed: true });
    await expect(requestSourceClip(p.id, { start: 10, end: 11 })).rejects.toThrow(/between 3 seconds and 3 minutes/);
    const r = await requestSourceClip(p.id, { start: 10, end: 40, title: "Big play" });
    expect(r.pending_clips).toEqual([{ start: 10, end: 40, title: "Big play", score: 0, reasons: [] }]);
    const webm = await addSource(Object.assign(new Blob([new Uint8Array(5)], { type: "video/webm" }), { name: "a.webm" }), { creator_name: "C" }, { status: "processing", evidence: "mine", confirmed: true });
    await expect(requestAnalysis(webm.id)).rejects.toThrow(/MP4 and MOV/);
  });
});
