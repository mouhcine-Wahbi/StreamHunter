import { db } from "@/local/db";
import { createHighlight, listHighlights, pruneOldData } from "@/local/highlights";
import { saveClip } from "@/local/clips";
import { viewerSpike } from "@/local/streamers";
import { configurePlatforms, fakePlatforms } from "@/test/platforms";
import type { OffscreenRequest } from "@/types/messages";
import type { Streamer } from "@/types/api";
import { createCaptureManager, getCaptureState, type CaptureDeps } from "./capture-manager";

const NOW = Date.parse("2026-11-17T12:00:00Z");

function deps(overrides: Partial<CaptureDeps> = {}) {
  const sent: OffscreenRequest[] = [];
  const notes: string[] = [];
  const d: CaptureDeps = {
    now: () => NOW,
    streamIdFor: vi.fn(async () => "stream-1"),
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    toOffscreen: vi.fn(async (m: OffscreenRequest) => {
      sent.push(m);
      return { ok: true };
    }),
    notify: async (title, message) => void notes.push(`${title}: ${message}`),
    navigate: vi.fn(async () => undefined),
    ...overrides,
  };
  return { d, sent, notes };
}

describe("capture manager (worker side)", () => {
  it("captures a channel tab: adds the streamer, starts the engine with the clip settings", async () => {
    await configurePlatforms();
    fakePlatforms({ twitch: [{ id: "1", login: "alpha", name: "Alpha", live: true }] });
    const { d, sent } = deps();
    const s = await createCaptureManager(d).start(7, "https://www.twitch.tv/Alpha");
    expect(s).toMatchObject({ status: "capturing", tabId: 7, platform: "twitch", channel: "alpha", streamerId: 1 });
    expect(d.streamIdFor).toHaveBeenCalledWith(7);
    expect(sent[0]).toMatchObject({
      type: "capture/start", streamId: "stream-1",
      capture: { streamerId: 1, platform: "twitch", displayName: "Alpha", username: "alpha" },
      options: { bufferSeconds: 120, preRollSeconds: 20, postRollSeconds: 20, maxClipSeconds: 90, clipThreshold: 40, weights: { audio: 25, chat: 30, visual: 20, viewers: 15, multi: 10 } },
    });
    expect(await db.all("streamers")).toHaveLength(1); // now on the monitoring list
  });

  it("works without platform credentials (keeps a local streamer record) and refuses other pages", async () => {
    fakePlatforms({});
    const { d } = deps();
    const m = createCaptureManager(d);
    await expect(m.start(1, "https://example.com")).rejects.toThrow("Open a Twitch or Kick channel");
    await m.start(1, "https://kick.com/somebody");
    expect(await db.all<Streamer>("streamers")).toMatchObject([{ platform: "kick", username: "somebody", platform_user_id: "local:somebody", monitoring_enabled: false }]);
  });

  it("reports Chrome refusing the capture and engine failures", async () => {
    fakePlatforms({});
    const refused = deps({ streamIdFor: vi.fn(async () => Promise.reject(new Error("Extension has not been invoked"))) });
    await expect(createCaptureManager(refused.d).start(1, "https://kick.com/a")).rejects.toThrow(/didn't allow capturing.*not been invoked/);
    const failing = deps({ toOffscreen: vi.fn(async () => ({ ok: false, error: "This browser can't encode H.264 video (WebCodecs)." })) });
    await expect(createCaptureManager(failing.d).start(1, "https://kick.com/a")).rejects.toThrow("H.264");
    expect(await getCaptureState()).toMatchObject({ status: "off", message: "This browser can't encode H.264 video (WebCodecs)." });
  });

  it("turns chat highlights of the recorded streamer into fusion signals, and saves the last 30 s on request", async () => {
    fakePlatforms({});
    const { d, sent, notes } = deps();
    const m = createCaptureManager(d);
    await m.start(1, "https://kick.com/alpha");
    const streamer = (await db.all<Streamer>("streamers"))[0]!;
    const h = await createHighlight({ streamer, session: null, origin: "chat", peakAt: NOW, startAt: NOW - 25_000, endAt: NOW + 25_000, score: 80,
      confidence: 0.9, category: "funny_moment", reasons: ["40 chatters laughing"], breakdown: { chat: 72 } });
    expect(await m.onHighlight(h, streamer)).toBe(true);
    expect(sent.at(-1)).toEqual({
      target: "offscreen", type: "capture/signal", slot: 1,
      signal: { kind: "chat", at: NOW, start: NOW - 5000, end: NOW + 5000, intensity: 72, reasons: ["40 chatters laughing"], highlightIds: [h.id] },
    });
    expect(await m.onHighlight(h, { ...streamer, id: 99 })).toBe(false); // another streamer: no clip

    await m.saveLast(30);
    const manual = (await listHighlights()).find((x) => x.reasons[0] === "Saved by you")!;
    expect(manual).toMatchObject({ origin: "capture", window_start_ms: NOW - 30_000, window_end_ms: NOW });
    expect(sent.at(-1)).toMatchObject({ type: "capture/clip", request: { highlightId: manual.id, start: NOW - 30_000, end: NOW } });

    await m.onClipSaved(1, 5, h.id, 30.2);
    expect(await getCaptureState()).toMatchObject({ clips: 1, message: "Clip saved (30 s)." });
    expect(notes).toEqual(["Clip saved: alpha: 40 chatters laughing (30 s)"]);

    await m.onTabRemoved(1);
    expect(await getCaptureState()).toMatchObject({ status: "off", message: "The captured tab was closed.", clips: 1 });
    expect(sent.at(-1)).toEqual({ target: "offscreen", type: "capture/stop", slot: 1 });
  });
});

describe("provisional signals and retention", () => {
  it("viewer spikes: a big jump over the broadcast's median, not slow growth", () => {
    expect(viewerSpike([200, 210, 205], 600)).toEqual({ from: 205, to: 600 });
    expect(viewerSpike([200, 210, 205], 280)).toBeNull();
    expect(viewerSpike([10, 12, 11], 120)).toBeNull(); // too small a stream to judge
    expect(viewerSpike([200], 600)).toBeNull(); // not enough history yet
  });

  it("deletes old provisional highlights and ended sessions, never highlights with a clip", async () => {
    const old = Date.parse("2026-10-01T12:00:00Z");
    const streamer = { id: 1, display_name: "A", username: "a", platform: "twitch" as const };
    const base = { streamer, session: null, origin: "chat" as const, score: 70, confidence: 0.5, category: "unknown", reasons: ["x"], breakdown: {} };
    const keep = await createHighlight({ ...base, peakAt: old, startAt: old, endAt: old });
    await createHighlight({ ...base, peakAt: old, startAt: old, endAt: old });
    await createHighlight({ ...base, peakAt: NOW, startAt: NOW, endAt: NOW });
    await saveClip({ candidateId: keep.id, sessionId: null, streamerId: 1, streamerName: "A", platform: "twitch", title: "t", startedAt: old,
      durationSec: 1, width: 2, height: 2, score: 70, blob: new Blob(["v"]) });
    await db.put("sessions", { id: 1, streamer_id: 1, status: "ended", started_at: "2026-10-01T10:00:00Z", ended_at: "2026-10-01T12:00:00Z" } as never);
    expect(await pruneOldData(30, new Date(NOW))).toBe(1);
    expect((await listHighlights()).map((h) => h.id).sort()).toEqual([keep.id, 3]);
    expect(await db.all("sessions")).toEqual([]);
  });
});
