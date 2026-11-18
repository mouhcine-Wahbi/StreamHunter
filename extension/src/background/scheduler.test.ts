import { db } from "@/local/db";
import { saveClip } from "@/local/clips";
import { patchMonitoringState, updateSettings } from "@/store/storage";
import type { OffscreenRequest } from "@/types/messages";
import { createCaptureManager, getSlots, SCHEDULER_KEY, type CaptureDeps, type SchedulerSnapshot } from "./capture-manager";
import { DEFAULT_SCHEDULER, nextRetry, plan, priorityOf, type SchedStreamer, type SchedulerConfig, type SlotView, type StreamerHistory } from "./scheduler";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MIN = 60_000;
const cfg = (over: Partial<SchedulerConfig> = {}): SchedulerConfig => ({ maxSlots: 3, ...DEFAULT_SCHEDULER, ...over });

function s(id: number, over: Partial<SchedStreamer> = {}): SchedStreamer {
  return {
    id, platform: "twitch", platform_user_id: String(id), username: `s${id}`, display_name: `S${id}`, profile_image_url: null, is_live: true,
    current_title: null, current_category: null, viewer_count: 1000, stream_started_at: "2026-11-18T10:00:00Z", status_checked_at: null,
    monitoring_enabled: true, is_favorite: false, auto_record: true, updated_at: "", priority: 0, ...over,
  };
}
const slot = (n: number, streamerId: number | null = null, over: Partial<SlotView> = {}): SlotView => ({
  slot: n, streamerId, assignedAt: streamerId ? new Date(NOW - 30 * MIN).toISOString() : null, pendingClips: 0, paused: false, ...over,
});
const hist = (recordedSeconds: number, clips: number, avgClipScore: number | null, recentMoments = 0): StreamerHistory => ({ recordedSeconds, clips, avgClipScore, recentMoments });

describe("priority score (explainable)", () => {
  it("weights highlight potential most, and explains every part", () => {
    const w = DEFAULT_SCHEDULER.weights;
    const fresh = priorityOf(s(1), undefined, w, NOW);
    expect(fresh.parts).toEqual({ potential: 50, activity: 0, growth: 18, user: 50, reliability: 100 });
    expect(fresh.total).toBe(Math.round((50 * 45 + 0 + 18 * 15 + 50 * 15 + 100 * 5) / 100));
    expect(fresh.explain[0]).toMatch(/not enough recording history yet/);
    // 6 clips in 1 h averaging 70 → potential 100·0.6 + 70·0.4 = 88; 2 moments in 30 min → activity 70.
    const proven = priorityOf(s(2), hist(3600, 6, 70, 2), w, NOW);
    expect(proven.parts).toMatchObject({ potential: 88, activity: 70 });
    expect(proven.explain[0]).toBe("Highlight potential 88: 6.0 clips per recorded hour here, average score 70.");
    // Viewers alone don't win: a huge stream with no history scores below a proven one.
    const big = priorityOf(s(3, { viewer_count: 90_000 }), undefined, w, NOW);
    expect(big.total).toBeLessThan(proven.total);
    // Growth: +60% over this broadcast's median.
    expect(priorityOf(s(4, { viewer_count: 1600, viewer_history: [1000, 1000, 1000, 1600] }), undefined, w, NOW).parts.growth).toBe(Math.round(100 * 0.7 + 64 * 0.3)); // audience size: log10(1600)/5 = 64
    // Your priority and favourites; failures lower reliability.
    expect(priorityOf(s(5, { priority: 2, is_favorite: true }), undefined, w, NOW).parts.user).toBe(100);
    expect(priorityOf(s(6, { priority: -2 }), undefined, w, NOW).parts.user).toBe(10);
    expect(priorityOf(s(7, { record_failures: 2 }), undefined, w, NOW).parts.reliability).toBe(40);
  });
});

describe("scheduler decisions", () => {
  it("fills free slots with the highest-priority eligible streamers and queues the rest with reasons", () => {
    const list = [s(1), s(2, { priority: 2 }), s(3, { priority: 1 }), s(4), s(5, { auto_record: false }), s(6, { is_live: false }),
      s(7, { record_failures: 1, record_retry_at: new Date(NOW + 2 * MIN).toISOString(), record_error: "black screen" })];
    const p = plan(list, new Map(), [slot(10), slot(11), slot(12)], cfg(), NOW);
    expect(p.decisions.map((d) => [d.slot, d.streamerId, d.action])).toEqual([[10, 2, "assign"], [11, 3, "assign"], [12, 1, "assign"]]);
    expect(p.queue.map((q) => [q.streamerId, q.reason])).toEqual([[4, "waiting_for_slot"], [5, "auto_record_off"], [7, "retry_wait"]]);
    expect(p.queue[0]!.detail).toBe("All 3 slots busy.");
    expect(p.queue[2]!.detail).toMatch(/^Recording failed \(black screen\); retrying /);
    // Only maxSlots slots are used even if more tabs are armed.
    expect(plan(list, new Map(), [slot(10), slot(11)], cfg({ maxSlots: 1 }), NOW).decisions).toHaveLength(1);
  });

  it("keeps healthy recordings: a slightly better streamer does not cause a switch", () => {
    const list = [s(1), s(2, { priority: 1 })]; // S2 scores 3 points more
    const p = plan(list, new Map(), [slot(10, 1)], cfg({ maxSlots: 1 }), NOW);
    expect(p.decisions).toEqual([expect.objectContaining({ slot: 10, streamerId: 1, action: "keep" })]);
    expect(p.queue[0]).toMatchObject({ streamerId: 2, reason: "waiting_for_slot" });
  });

  it("switches only when clearly better AND after the minimum time, the cooldown and pending clips", () => {
    const list = [s(1, { priority: -2 }), s(2, { priority: 2, is_favorite: true })]; // 13–14 points apart (user part 10 vs 100)
    const ok = plan(list, new Map(), [slot(10, 1)], cfg({ maxSlots: 1 }), NOW);
    expect(ok.decisions[0]).toMatchObject({ streamerId: 2, action: "switch", detail: expect.stringMatching(/S2 \(priority \d+\) replaces S1 \(\d+\): \d+ points higher/) });
    expect(ok.queue).toEqual([expect.objectContaining({ streamerId: 1, reason: "waiting_for_slot" })]);
    const young = plan(list, new Map(), [slot(10, 1, { assignedAt: new Date(NOW - 3 * MIN).toISOString() })], cfg({ maxSlots: 1 }), NOW);
    expect(young.decisions[0]).toMatchObject({ streamerId: 1, action: "keep" });
    expect(plan([s(1), s(2, { is_favorite: true })], new Map(), [slot(10, 1)], cfg({ maxSlots: 1 }), NOW).decisions[0]!.streamerId).toBe(1); // favourite alone: +7.5, no switch
    expect(young.queue[0]!.detail).toMatch(/will replace the weakest recording when its minimum time and cooldown allow/);
    const cooling = plan(list, new Map(), [slot(10, 1)], cfg({ maxSlots: 1 }), NOW, new Set(), new Map([[10, new Date(NOW - 2 * MIN).toISOString()]]));
    expect(cooling.decisions[0]!.streamerId).toBe(1);
    const saving = plan(list, new Map(), [slot(10, 1, { pendingClips: 1 })], cfg({ maxSlots: 1 }), NOW);
    expect(saving.decisions[0]!.streamerId).toBe(1);
    const paused = plan(list, new Map(), [slot(10, 1, { paused: true })], cfg({ maxSlots: 1 }), NOW);
    expect(paused.decisions[0]!.streamerId).toBe(1);
    // At most one switch per run.
    const two = plan([s(1, { priority: -2 }), s(3, { priority: -2 }), s(2, { priority: 2, is_favorite: true }), s(4, { priority: 2, is_favorite: true })], new Map(), [slot(10, 1), slot(11, 3)], cfg({ maxSlots: 2 }), NOW);
    expect(two.decisions.filter((d) => d.action === "switch")).toHaveLength(1);
  });

  it("releases slots of streamers that went offline and reassigns them; never records a streamer twice", () => {
    const list = [s(1, { is_live: false }), s(2), s(3)];
    const p = plan(list, new Map(), [slot(10, 1), slot(11, 2)], cfg({ maxSlots: 2 }), NOW, new Set([3]));
    expect(p.decisions.map((d) => [d.slot, d.streamerId, d.action])).toEqual([[10, null, "release"], [11, 2, "keep"]]);
    expect(p.queue).toEqual([expect.objectContaining({ streamerId: 3, reason: "recorded_elsewhere" })]);
    const p2 = plan([s(1, { is_live: false }), s(2), s(4)], new Map(), [slot(10, 1), slot(11, 2)], cfg({ maxSlots: 2 }), NOW);
    expect(p2.decisions.map((d) => [d.slot, d.streamerId, d.action])).toEqual([[10, 4, "switch"], [11, 2, "keep"]]);
  });

  it("retries a failing streamer after 2, 5, 15 minutes, then gives up for that broadcast", () => {
    expect(nextRetry(1, NOW, 3)).toBe(new Date(NOW + 2 * MIN).toISOString());
    expect(nextRetry(2, NOW, 3)).toBe(new Date(NOW + 5 * MIN).toISOString());
    expect(nextRetry(3, NOW, 3)).toBeNull();
    expect(nextRetry(3, NOW, 5)).toBe(new Date(NOW + 15 * MIN).toISOString());
    const p = plan([s(1, { record_failures: 3, record_error: "black screen" })], new Map(), [slot(10)], cfg(), NOW);
    expect(p.decisions[0]!.streamerId).toBeNull();
    expect(p.queue[0]).toMatchObject({ reason: "gave_up", detail: expect.stringMatching(/failed 3 times \(black screen\); not retried until the next broadcast/) });
  });
});

describe("scheduler in the worker (slots, failures, reassignment)", () => {
  function deps() {
    const sent: OffscreenRequest[] = [];
    const navigations: [number, string][] = [];
    const notes: string[] = [];
    let clock = NOW;
    const d: CaptureDeps = {
      now: () => clock,
      streamIdFor: vi.fn(async (tab: number) => `stream-${tab}`),
      ensureOffscreen: vi.fn(async () => undefined),
      closeOffscreen: vi.fn(async () => undefined),
      toOffscreen: vi.fn(async (m: OffscreenRequest) => {
        sent.push(m);
        return { ok: true };
      }),
      notify: async (t, m) => void notes.push(`${t}: ${m}`),
      navigate: vi.fn(async (tab: number, url: string) => void navigations.push([tab, url])),
    };
    return { d, sent, navigations, notes, tick: (ms: number) => (clock += ms) };
  }

  beforeEach(async () => {
    await patchMonitoringState({ enabled: true, status: "active" });
    await updateSettings({ recording: { maxStreams: 2 } });
  });

  it("ranks by highlight potential (not viewers), saves an explained snapshot, and reassigns a slot when a recording fails", async () => {
    await db.put("streamers", s(1, { viewer_count: 50_000 }));
    await db.put("streamers", s(2, { viewer_count: 300, recorded_seconds: 7200 } as Partial<SchedStreamer>));
    await db.put("streamers", s(3, { viewer_count: 800 }));
    // S2 made 10 strong clips in 2 h here.
    for (let i = 0; i < 10; i++)
      await saveClip({ candidateId: 100 + i, sessionId: null, streamerId: 2, streamerName: "S2", platform: "twitch", title: "c", startedAt: NOW, durationSec: 40, width: 2, height: 2, score: 80, blob: new Blob(["x"]) });
    const { d, sent, navigations, notes } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    await m.arm(11);
    expect((await getSlots()).map((x) => x.channel)).toEqual(["s2", "s1"]);
    const snap = (await chrome.storage.local.get(SCHEDULER_KEY))[SCHEDULER_KEY] as SchedulerSnapshot;
    expect(snap).toMatchObject({ maxSlots: 2, armedSlots: 2, tracked: 3, live: 3 });
    expect(snap.priorities[0]).toMatchObject({ name: "S2", parts: { potential: 92 } });
    expect(snap.queue).toEqual([expect.objectContaining({ name: "S3", reason: "waiting_for_slot", detail: "All 2 slots busy." })]);

    // S1's player shows no picture for 45 s → failed: slot 10 or 11 moves to S3, S1 retries in 2 min.
    const slotOfS1 = (await getSlots()).find((x) => x.streamerId === 1)!.tabId!;
    await m.onStatus(slotOfS1, { bufferedSeconds: 60, levelDb: -30, health: { fps: 0, dropped: 0, queue: 0, throttled: false, noVideoSeconds: 45 } });
    expect((await getSlots()).map((x) => x.channel).sort()).toEqual(["s2", "s3"]);
    expect(navigations.at(-1)).toEqual([slotOfS1, "https://www.twitch.tv/s3"]);
    const s1 = await db.get<SchedStreamer>("streamers", 1);
    expect(s1).toMatchObject({ record_failures: 1, record_error: "the player shows no picture (frozen, paused or blocked)", record_retry_at: new Date(NOW + 2 * MIN).toISOString() });
    expect(notes.at(-1)).toBe("Recording problem: S1: the player shows no picture (frozen, paused or blocked).");
    const snap2 = (await chrome.storage.local.get(SCHEDULER_KEY))[SCHEDULER_KEY] as SchedulerSnapshot;
    expect(snap2.queue[0]).toMatchObject({ name: "S1", reason: "retry_wait" });
    expect(snap2.failures).toEqual([expect.objectContaining({ name: "S1", failures: 1 })]);
    expect(sent.some((x) => x.type === "capture/target" && x.slot === slotOfS1 && x.capture === null)).toBe(true);
  });

  it("a new broadcast clears the previous one's failures", async () => {
    await db.put("streamers", { ...s(1), record_failures: 3, record_error: "black screen", record_failure_broadcast: "2026-11-17T10:00:00Z" } as SchedStreamer);
    const { d } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    expect((await getSlots())[0]!.channel).toBe("s1");
    expect(await db.get<SchedStreamer>("streamers", 1)).toMatchObject({ record_failures: 0 });
  });

  it("a scheduling error never leaves an engine encoding while the slot says it isn't (found in real Chrome)", async () => {
    await db.put("streamers", { ...s(1), username: undefined } as unknown as SchedStreamer);
    const { d, sent } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    const slot = (await getSlots())[0]!;
    expect(slot).toMatchObject({ recording: false, streamerId: null, message: "Scheduling error: S1 has no channel name" });
    expect(sent.filter((x) => x.type === "capture/target" && x.slot === 10).map((x) => (x as { capture: unknown }).capture)).toEqual([null]);
  });

  it("recognises a broken player: no picture, black picture, or silent and motionless (YouTube error page)", async () => {
    const { playerProblem } = await import("./capture-manager");
    const h = (o: object) => ({ fps: 10, dropped: 0, queue: 0, throttled: false, ...o });
    expect(playerProblem(h({ noVideoSeconds: 44 }), 0)).toBeNull();
    expect(playerProblem(h({ noVideoSeconds: 45 }), 0)).toMatch(/no picture/);
    expect(playerProblem(h({ blackSeconds: 60 }), 0)).toMatch(/black screen/);
    expect(playerProblem(h({ staticSeconds: 40 }), 10)).toBeNull(); // a calm stream with sound is fine
    expect(playerProblem(h({ staticSeconds: 5 }), 60)).toBeNull(); // a quiet streamer who moves is fine
    expect(playerProblem(h({ staticSeconds: 30 }), 30)).toMatch(/stalled/);
  });
});
