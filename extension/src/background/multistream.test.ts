import { approveAllLive } from "@/test/approvals";
import { db } from "@/local/db";
import { createHighlight } from "@/local/highlights";
import { patchMonitoringState, updateSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import { INITIAL_CAPTURE_STATE, type CaptureState } from "@/types/capture";
import type { OffscreenRequest } from "@/types/messages";
import { assignTargets, createCaptureManager, getCaptureState, getSlots, type CaptureDeps } from "./capture-manager";
import { cpuPercent, createGovernor, decide, LIMITS, type GovernorMemory } from "./resource-governor";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const GB = 1024 ** 3;

function streamer(id: number, over: Partial<Streamer> = {}): Streamer {
  return {
    id, platform: "twitch", platform_user_id: String(id), username: `s${id}`, display_name: `S${id}`, profile_image_url: null, is_live: true,
    current_title: null, current_category: null, viewer_count: 1000 - id * 100, stream_started_at: null, status_checked_at: null,
    monitoring_enabled: true, is_favorite: false, auto_record: true, updated_at: "", ...over,
  };
}

function deps() {
  const sent: OffscreenRequest[] = [];
  const navigations: [number, string][] = [];
  let clock = NOW;
  const d: CaptureDeps = {
    approvals: approveAllLive,
    now: () => (clock += 1000),
    streamIdFor: vi.fn(async (tab: number) => `stream-${tab}`),
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    toOffscreen: vi.fn(async (m: OffscreenRequest) => {
      sent.push(m);
      return { ok: true };
    }),
    notify: async () => undefined,
    navigate: vi.fn(async (tab: number, url: string) => void navigations.push([tab, url])),
  };
  return { d, sent, navigations };
}

describe("assigning live streamers to recorder slots", () => {
  it("fills free slots by priority, keeps current assignments, never records a streamer twice", () => {
    const list = [streamer(1), streamer(2), streamer(3), streamer(4, { is_favorite: true }), streamer(5, { auto_record: false })];
    expect(assignTargets(list, [{ slot: 10, current: null }, { slot: 11, current: null }])).toEqual({ 10: list[3], 11: list[0] });
    // Sticky: slot 11 keeps S3 even though S1 has more viewers.
    expect(assignTargets(list, [{ slot: 10, current: null }, { slot: 11, current: 3 }])).toEqual({ 10: list[3], 11: list[2] });
    // Two slots can't both keep the same streamer.
    expect(assignTargets(list, [{ slot: 10, current: 1 }, { slot: 11, current: 1 }])).toEqual({ 10: list[0], 11: list[3] });
    // Streamers in a manual capture are skipped; more slots than live streamers → idle slots.
    expect(assignTargets([streamer(1), streamer(2)], [{ slot: 1, current: null }, { slot: 2, current: null }, { slot: 3, current: null }], new Set([1]))).toEqual({ 1: expect.objectContaining({ id: 2 }), 2: null, 3: null });
  });
});

describe("several recorder slots", () => {
  beforeEach(async () => {
    await patchMonitoringState({ enabled: true, status: "active" });
    await updateSettings({ recording: { maxStreams: 3 } });
    for (const id of [1, 2, 3, 4]) await db.put("streamers", streamer(id));
  });

  it("records a different live streamer in each armed tab, up to the limit", async () => {
    const { d, sent, navigations } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await m.arm(11);
    await m.arm(12);
    const slots = await getSlots();
    expect(slots.map((s) => [s.tabId, s.channel, s.recording])).toEqual([[10, "s1", true], [11, "s2", true], [12, "s3", true]]);
    expect(navigations).toEqual([[10, "https://www.twitch.tv/s1"], [11, "https://www.twitch.tv/s2"], [12, "https://www.twitch.tv/s3"]]);
    expect(sent.filter((x) => x.type === "capture/start").map((x) => (x as { slot: number }).slot)).toEqual([10, 11, 12]);
    // Only the first slot plays its sound.
    expect(slots.map((s) => s.listening)).toEqual([true, false, false]);
    expect(sent.find((x) => x.type === "capture/start" && x.slot === 11)).toMatchObject({ options: { listen: false, quality: "720p" } });
    // A fourth tab is refused at the limit.
    await expect(m.arm(13)).rejects.toThrow("Already recording 3 streams (the limit)");
    // S2 goes offline → slot 11 takes S4; the others don't move.
    await db.put("streamers", streamer(2, { is_live: false }));
    await m.sync();
    expect((await getSlots()).map((s) => s.channel)).toEqual(["s1", "s4", "s3"]);
    expect(navigations.at(-1)).toEqual([11, "https://www.twitch.tv/s4"]);
  });

  it("routes chat/viewer signals to the slot recording that streamer, and keeps concurrent reports", async () => {
    const { d, sent } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await m.arm(11);
    const h = await createHighlight({ streamer: streamer(2), session: null, origin: "chat", peakAt: NOW, startAt: NOW - 20_000, endAt: NOW + 20_000, score: 70,
      confidence: 0.8, category: "x", reasons: ["Chat spike"], breakdown: { chat: 70 } });
    expect(await m.onHighlight(h, streamer(2))).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "capture/signal", slot: 11, signal: { kind: "chat", intensity: 70 } });
    expect(await m.onHighlight(h, streamer(4))).toBe(false); // not recorded anywhere
    // Engines report at the same time: no report may overwrite another.
    await Promise.all([
      m.onStatus(10, { bufferedSeconds: 30, levelDb: -20, health: { fps: 30, dropped: 0, queue: 0, throttled: false } }),
      m.onStatus(11, { bufferedSeconds: 45, levelDb: -25, health: { fps: 29.5, dropped: 2, queue: 1, throttled: false } }),
      m.onDetection(10, { at: NOW, reasons: ["Loud"], score: 50, clipped: true }),
    ]);
    const [a, b] = await getSlots();
    expect([a!.bufferedSeconds, a!.health?.fps, a!.lastDetection?.score, b!.bufferedSeconds, b!.health?.dropped]).toEqual([30, 30, 50, 45, 2]);
  });

  it("per-stream Pause/Resume/Stop and sound, independent of the others", async () => {
    const { d, sent } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await m.arm(11);
    await m.arm(12);
    await m.setPaused(true, 11, "you");
    expect(sent.at(-1)).toEqual({ target: "offscreen", type: "capture/pause", slot: 11, paused: true });
    expect((await getSlots()).map((s) => [s.tabId, s.recording, s.pauseReason])).toEqual([[10, true, null], [11, false, "you"], [12, true, null]]);
    // Pause/Resume monitoring leaves the editor's own pause alone.
    await m.setPaused(true);
    await m.setPaused(false);
    expect((await getSlots()).map((s) => [s.tabId, s.paused, s.pauseReason])).toEqual([[10, false, null], [11, true, "you"], [12, false, null]]);
    await m.setPaused(false, 11, "you");
    expect((await getCaptureState(11)).recording).toBe(true);
    // Listen to slot 12 → slot 10 goes quiet.
    await m.setListening(12, true);
    expect((await getSlots()).map((s) => s.listening)).toEqual([false, false, true]);
    // Stop the listened slot → the sound goes to the first remaining one.
    await m.stop(12);
    expect(sent.some((x) => x.type === "capture/stop" && x.slot === 12)).toBe(true);
    expect((await getSlots()).map((s) => [s.tabId, s.listening])).toEqual([[10, true], [11, false]]);
    // Closing a recorder tab stops only that slot.
    await m.onTabRemoved(10);
    expect((await getSlots()).map((s) => s.tabId)).toEqual([11]);
  });

  it("lowering the limit stops the newest slots; a streamer already recorded can't be captured twice", async () => {
    const { d } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await m.arm(11);
    await m.arm(12);
    await updateSettings({ recording: { maxStreams: 2 } });
    await m.sync();
    expect((await getSlots()).map((s) => s.tabId)).toEqual([10, 11]);
    await updateSettings({ recording: { maxStreams: 3 } });
    await expect(m.start(20, "https://www.twitch.tv/s1")).rejects.toThrow("S1 is already being recorded in another tab.");
    await m.stop();
    expect(await getSlots()).toEqual([]);
    expect(d.closeOffscreen).toHaveBeenCalled();
  });

  it("the single-stream default is unchanged: one slot, a second one is refused", async () => {
    await updateSettings({ recording: { maxStreams: 1 } });
    const { d } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await expect(m.arm(11)).rejects.toThrow("Already recording one stream");
    expect((await getCaptureState()).channel).toBe("s1");
  });
});

describe("overload protection", () => {
  const slot = (tabId: number, over: Partial<CaptureState> = {}): CaptureState => ({
    ...INITIAL_CAPTURE_STATE, status: "capturing", recording: true, tabId, channel: `s${tabId}`, health: { fps: 30, dropped: 0, queue: 0, throttled: false }, ...over,
  });
  const fresh: GovernorMemory = { overloadedRuns: 0, healthyRuns: 0 };
  const hot = { cpuPercent: 96, memAvailableBytes: 8 * GB, storageFreeBytes: 100 * GB };
  const ok = { cpuPercent: 40, memAvailableBytes: 8 * GB, storageFreeBytes: 100 * GB };

  it("waits ~30 s, then lowers the lowest-priority stream's frame rate, then pauses it", () => {
    let slots = [slot(1), slot(2), slot(3)];
    let mem = fresh;
    for (let i = 1; i < LIMITS.overloadedSamples; i++) {
      const d = decide(hot, slots, mem);
      expect(d).toMatchObject({ overloaded: false, reason: "CPU at 96%", actions: [] }); // a spike, not yet overload
      mem = d.memory;
    }
    let d = decide(hot, slots, mem);
    expect(d.actions).toEqual([{ kind: "throttle", tabId: 3, on: true }]);
    expect(d.note).toBe("CPU at 96%: recording s3 at half frame rate.");
    slots = [slot(1), slot(2, { health: { fps: 15, dropped: 0, queue: 0, throttled: true } }), slot(3, { health: { fps: 15, dropped: 0, queue: 0, throttled: true } })];
    slots[0]!.health!.throttled = true;
    mem = d.memory;
    for (let i = 1; i < LIMITS.overloadedSamples; i++) mem = decide(hot, slots, mem).memory;
    d = decide(hot, slots, mem);
    expect(d.actions).toEqual([{ kind: "pause", tabId: 3, paused: true, reason: "overload" }]);
    // The last stream left recording is never paused for overload.
    const single = [slot(1, { health: { fps: 15, dropped: 0, queue: 0, throttled: true } })];
    mem = fresh;
    for (let i = 0; i < 5; i++) {
      d = decide(hot, single, mem);
      mem = d.memory;
      expect(d.actions).toEqual([]);
    }
  });

  it("counts low memory and dropped frames as overload, but not a low frame rate (static page)", () => {
    expect(decide({ ...ok, memAvailableBytes: 0.8 * GB }, [slot(1)], fresh).reason).toBe("only 0.8 GB of memory free");
    expect(decide({ ...ok, memAvailableBytes: 2 * GB }, [slot(1)], fresh).reason).toBeNull(); // normal on a busy Mac
    expect(decide(ok, [slot(1), slot(2, { health: { fps: 12, dropped: 40, droppedRecent: 25, queue: 8, throttled: false } })], fresh).reason).toBe("s2 is dropping frames (the encoder is behind)");
    // Seen in real Chrome: an offline Twitch page only changes a few times a second → 3 fps, no drops.
    expect(decide(ok, [slot(1, { health: { fps: 2.7, dropped: 0, droppedRecent: 0, queue: 0, throttled: false } })], fresh).reason).toBeNull();
    expect(decide({ ...ok, cpuPercent: null, memAvailableBytes: null }, [slot(1)], fresh).overloaded).toBe(false);
  });

  it("undoes one step after a minute of normal load: resume first, then full frame rate", () => {
    const slots = [slot(1, { health: { fps: 15, dropped: 0, queue: 0, throttled: true } }), slot(2, { recording: false, paused: true, pauseReason: "overload" })];
    let mem = fresh;
    for (let i = 1; i < LIMITS.healthySamples; i++) {
      const d = decide(ok, slots, mem);
      expect(d.actions).toEqual([]);
      mem = d.memory;
    }
    expect(decide(ok, slots, mem).actions).toEqual([{ kind: "pause", tabId: 2, paused: false, reason: "overload" }]);
    mem = fresh;
    for (let i = 1; i < LIMITS.healthySamples; i++) mem = decide(ok, [slots[0]!], mem).memory;
    expect(decide(ok, [slots[0]!], mem).actions).toEqual([{ kind: "throttle", tabId: 1, on: false }]);
  });

  it("disk almost full: clean up and pause every running stream; resume when space is back", () => {
    const slots = [slot(1), slot(2, { paused: true, pauseReason: "you", recording: false })];
    const d = decide({ ...ok, storageFreeBytes: 1 * GB }, slots, fresh);
    expect(d.actions).toEqual([{ kind: "cleanup" }, { kind: "pause", tabId: 1, paused: true, reason: "storage" }]);
    const after = decide(ok, [slot(1, { paused: true, pauseReason: "storage", recording: false }), slots[1]!], fresh);
    expect(after.actions).toEqual([{ kind: "pause", tabId: 1, paused: false, reason: "storage" }]);
  });

  it("computes whole-machine CPU from processor ticks and measures at most every 10 s", async () => {
    const t = (busy: number, idle: number) => ({ usage: { user: busy, kernel: 0, idle, total: busy + idle } });
    expect(cpuPercent([t(100, 900), t(100, 900)], [t(400, 1600), t(200, 1800)])).toBe(20);
    let now = NOW;
    const saved: unknown[] = [];
    let calls = 0;
    const g = createGovernor({
      now: () => now,
      readCpu: async () => (calls++ === 0 ? [t(0, 0)] : [t(950, 50)]),
      readMemory: async () => ({ availableCapacity: 6 * GB, capacity: 16 * GB }),
      readStorage: async () => ({ usage: GB, quota: 200 * GB }),
      slots: async () => [slot(1)],
      enabled: async () => true,
      apply: async () => undefined,
      notify: async () => undefined,
      save: async (l) => void saved.push(l),
    });
    await g.maybeRun();
    await g.maybeRun(); // within 10 s: skipped
    now += 10_000;
    await g.maybeRun();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ cpuPercent: 95, memAvailableBytes: 6 * GB, memCapacityBytes: 16 * GB, storageQuotaBytes: 200 * GB, overloaded: false, reason: "CPU at 95%" });
  });
});
