import { createHighlight, failInterruptedClips, listHighlights, markClipFailed } from "./highlights";
import { saveClip, saveFailureReason, listClips } from "./clips";
import { LocalApi } from "./local-api";
import { createAdapters } from "@/platforms/registry";
import type { Page } from "@/types/api";
import type { LocalHighlight } from "./highlights";

const T = Date.parse("2026-11-18T12:00:00Z");
const base = { streamer: { id: 1, display_name: "A", username: "a", platform: "twitch" as const }, session: null, origin: "capture" as const, peakAt: T, startAt: T - 20_000, endAt: T + 20_000, score: 60, confidence: 0.7, category: "x", reasons: ["Loud"], breakdown: {} };

describe("clip lifecycle: detected → generating → ready / failed", () => {
  it("tracks each automatic clip's state and lists in-progress and failed ones", async () => {
    const ready = await createHighlight({ ...base, clipStatus: "generating" });
    const gen = await createHighlight({ ...base, clipStatus: "generating" });
    const bad = await createHighlight({ ...base, clipStatus: "generating" });
    const provisional = await createHighlight({ ...base, origin: "chat" }); // never had video
    await saveClip({ candidateId: ready.id, sessionId: null, streamerId: 1, streamerName: "A", platform: "twitch", title: "t", startedAt: T, durationSec: 40, width: 2, height: 2, score: 60, blob: new Blob(["v"]),
      explain: { parts: { audio: 20, chat: 21, visual: 0, viewers: 0, multi: 10 }, confidence: 0.7, eventSeconds: 6.5 } });
    await markClipFailed(bad.id, "That moment is no longer in the recording buffer.");
    const list = await listHighlights();
    const st = (id: number) => list.find((h) => h.id === id)!;
    expect([st(ready.id).clip_status, st(gen.id).clip_status, st(bad.id).clip_status, st(provisional.id).clip_status]).toEqual(["ready", "generating", "failed", undefined]);
    expect(st(bad.id).clip_error).toBe("That moment is no longer in the recording buffer.");
    const api = new LocalApi(() => createAdapters());
    const pending = await api.get<Page<LocalHighlight>>("/api/v1/highlights?clip_status=generating,failed");
    expect(pending.items.map((h) => h.id).sort()).toEqual([gen.id, bad.id].sort());
    // The clip keeps its score explanation.
    expect((await listClips())[0]).toMatchObject({ score_parts: { audio: 20, chat: 21, multi: 10 }, confidence: 0.7, event_seconds: 6.5 });
  });

  it("after a restart, clips that were still generating are marked failed (never phantom clips)", async () => {
    const gen = await createHighlight({ ...base, clipStatus: "generating" });
    expect(await failInterruptedClips()).toBe(1);
    expect((await listHighlights()).find((h) => h.id === gen.id)).toMatchObject({ clip_status: "failed", clip_error: "Chrome or StreamHunter stopped before this clip was saved.", has_video: false });
    expect(await failInterruptedClips()).toBe(0);
  });

  it("explains storage-full errors", () => {
    expect(saveFailureReason(Object.assign(new Error("x"), { name: "QuotaExceededError" }))).toBe("Browser storage is full: delete clips or lower the storage limit in Settings.");
    expect(saveFailureReason(new Error("Encountered full disk while opening backing store"))).toBe("The clip could not be stored (Encountered full disk while opening backing store).");
  });
});
