/**
 * 3.0 recording approvals: nothing is recorded without your approval of that exact broadcast.
 * These tests use the real stored approvals (no "approve everything" stand-in).
 */
import { db } from "@/local/db";
import { approvalId, approvedIds, ApprovalError, decide, HISTORY_LIMIT, readApprovals, reconcile, type Approval } from "@/local/approvals";
import { broadcastIdOf } from "@/local/streamers";
import { patchMonitoringState, getSettings, updateSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import type { OffscreenRequest } from "@/types/messages";
import type { ChannelInfo } from "@/platforms/types";
import { createApprovalManager } from "./approval-manager";
import { createCaptureManager, getSlots, SCHEDULER_KEY, type CaptureDeps, type SchedulerSnapshot } from "./capture-manager";
import { handleMessage } from "./message-handler";
import type { MonitoringManager } from "./monitoring-manager";

const T0 = new Date("2026-11-21T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function streamer(id: number, over: Partial<Streamer> = {}): Streamer {
  return {
    id, platform: "twitch", platform_user_id: String(id), username: `s${id}`, display_name: `S${id}`, profile_image_url: null, is_live: true,
    current_title: `Title ${id}`, current_category: "Just Chatting", viewer_count: 1000 - id * 100, stream_started_at: "2026-11-21T11:00:00Z", status_checked_at: null,
    monitoring_enabled: true, is_favorite: false, auto_record: true, updated_at: "", broadcast_id: `twitch:b${id}`, ...over,
  };
}

describe("approval rules (pure)", () => {
  it("asks once per broadcast: one request, one notification, never repeated", () => {
    const list = [streamer(1), streamer(2, { auto_record: false }), streamer(3, { is_live: false, broadcast_id: null }), streamer(4, { monitoring_enabled: false })];
    const r1 = reconcile([], list, T0);
    expect(r1.items.map((a) => [a.streamerId, a.status])).toEqual([[1, "pending"]]);
    expect(r1.notify.map((a) => a.id)).toEqual([approvalId(1, "twitch:b1")]);
    expect(r1.items[0]).toMatchObject({ title: "Title 1", category: "Just Chatting", viewers: 900, notifications: 1 });
    const r2 = reconcile(r1.items, list, at(2));
    expect(r2.notify).toEqual([]);
    expect(r2.items).toHaveLength(1);
  });

  it("an approval covers only its broadcast: a new broadcast needs a new approval", () => {
    let items = reconcile([], [streamer(1)], T0).items;
    expect(approvedIds(items, [streamer(1)]).size).toBe(0); // pending is not approved
    items = decide(items, approvalId(1, "twitch:b1"), "approve", at(1), 10);
    expect([...approvedIds(items, [streamer(1)])]).toEqual([1]);
    // Same streamer, new broadcast (stream restarted): the old approval closes, a new request opens.
    const restarted = streamer(1, { broadcast_id: "twitch:b1-second" });
    expect(approvedIds(items, [restarted]).size).toBe(0); // checked against the live broadcast even before reconcile
    const r = reconcile(items, [restarted], at(5));
    expect(r.expired.map((a) => [a.broadcastId, a.status, a.note])).toEqual([["twitch:b1", "approved", "The broadcast ended (a new one started)."]]);
    expect(r.notify.map((a) => a.broadcastId)).toEqual(["twitch:b1-second"]);
    expect(approvedIds(r.items, [restarted]).size).toBe(0);
  });

  it("requests expire when the broadcast ends; closed requests can't be decided", () => {
    let items = reconcile([], [streamer(1), streamer(2)], T0).items;
    items = decide(items, approvalId(2, "twitch:b2"), "approve", at(1), 10);
    const r = reconcile(items, [streamer(1, { is_live: false, broadcast_id: null }), streamer(2, { is_live: false, broadcast_id: null })], at(30));
    const byId = new Map(r.items.map((a) => [a.streamerId, a]));
    expect(byId.get(1)).toMatchObject({ status: "expired", note: "Not answered. The broadcast ended.", endedAt: at(30).toISOString() });
    expect(byId.get(2)).toMatchObject({ status: "approved", note: "The broadcast ended.", endedAt: at(30).toISOString() });
    expect(() => decide(r.items, approvalId(1, "twitch:b1"), "approve", at(31), 10)).toThrow(ApprovalError);
    expect(() => decide(r.items, approvalId(1, "twitch:b1"), "approve", at(31), 10)).toThrow(/broadcast has ended/);
    expect(() => decide(r.items, "nope", "approve", at(31), 10)).toThrow(/no longer exists/);
    // Removed streamer / Ask to record turned off also close the request.
    const r2 = reconcile(reconcile([], [streamer(5), streamer(6)], T0).items, [streamer(6, { auto_record: false })], at(1));
    expect(r2.expired.map((a) => a.note)).toEqual(["Not answered. The streamer was removed from your list.", "Not answered. Recording requests were turned off for this streamer."]);
  });

  it("decline, remind me later (asks again once, same broadcast) and stop", () => {
    let items = reconcile([], [streamer(1), streamer(2), streamer(3)], T0).items;
    items = decide(items, approvalId(1, "twitch:b1"), "decline", at(1), 10);
    items = decide(items, approvalId(2, "twitch:b2"), "remind", at(1), 10);
    expect(approvedIds(items, [streamer(1), streamer(2)]).size).toBe(0);
    expect(reconcile(items, [streamer(1), streamer(2), streamer(3)], at(10)).notify).toEqual([]); // not due yet
    const due = reconcile(items, [streamer(1), streamer(2), streamer(3)], at(11));
    expect(due.notify.map((a) => [a.streamerId, a.status, a.notifications])).toEqual([[2, "pending", 2]]);
    expect(reconcile(due.items, [streamer(1), streamer(2), streamer(3)], at(30)).notify).toEqual([]); // once
    // Changing your mind while it's live; stopping an approved recording.
    items = decide(due.items, approvalId(1, "twitch:b1"), "approve", at(12), 10);
    expect([...approvedIds(items, [streamer(1)])]).toEqual([1]);
    items = decide(items, approvalId(1, "twitch:b1"), "stop", at(13), 10);
    expect(items.find((a) => a.streamerId === 1)).toMatchObject({ status: "declined", note: "Recording stopped by you." });
    expect(() => decide(items, approvalId(3, "twitch:b3"), "stop", at(13), 10)).toThrow(/Only an approved stream/);
  });

  it("keeps a bounded history", () => {
    let items: Approval[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      items = reconcile(items, [streamer(1, { broadcast_id: `twitch:x${i}` })], at(i)).items;
    }
    expect(items.length).toBe(HISTORY_LIMIT + 1); // the open one + HISTORY_LIMIT closed
    expect(items[0]).toMatchObject({ broadcastId: `twitch:x${HISTORY_LIMIT + 19}`, endedAt: null });
  });

  it("identifies a broadcast by the platform's stream ID, else its start time, else the first check that saw it", () => {
    const c = (over: Partial<ChannelInfo>): ChannelInfo => ({ platform: "kick", platform_user_id: "7", username: "k", display_name: "K", profile_image_url: null, is_live: true, current_title: null, current_category: null, viewer_count: null, stream_started_at: null, ...over });
    const off = streamer(7, { is_live: false, broadcast_id: null });
    expect(broadcastIdOf(c({ platform: "youtube", stream_id: "vid123" }), off, T0)).toBe("youtube:vid123");
    expect(broadcastIdOf(c({ stream_started_at: "2026-11-21T10:00:00.000Z" }), off, T0)).toBe("kick:7@2026-11-21T10:00:00.000Z");
    const seen = broadcastIdOf(c({}), off, T0);
    expect(seen).toBe(`kick:7~${T0.toISOString()}`);
    expect(broadcastIdOf(c({}), streamer(7, { broadcast_id: seen }), at(2))).toBe(seen); // still live: same broadcast
  });
});

describe("approval gate in the worker (real stored approvals)", () => {
  function deps() {
    const sent: OffscreenRequest[] = [];
    let clock = T0.getTime();
    const d: CaptureDeps = {
      now: () => (clock += 1000),
      streamIdFor: vi.fn(async (tab: number) => `stream-${tab}`),
      ensureOffscreen: vi.fn(async () => undefined),
      closeOffscreen: vi.fn(async () => undefined),
      toOffscreen: vi.fn(async (m: OffscreenRequest) => {
        sent.push(m);
        return { ok: true };
      }),
      notify: async () => undefined,
      navigate: vi.fn(async () => undefined),
    };
    return { d, sent };
  }
  const notified: Approval[][] = [];
  let now = T0;
  const cleared: string[] = [];
  const approvals = createApprovalManager({ now: () => now, notify: async (list) => void notified.push(list), clear: async (id) => void cleared.push(id) });

  beforeEach(async () => {
    notified.length = 0;
    cleared.length = 0;
    now = T0;
    await patchMonitoringState({ enabled: true, status: "active" });
    await updateSettings({ recording: { maxStreams: 3 } });
  });

  it("never records a live stream until you approve it, then records it; a new broadcast asks again", async () => {
    await db.put("streamers", streamer(1));
    const { d, sent } = deps();
    const m = createCaptureManager(d);
    await m.arm(10);
    let slot = (await getSlots())[0]!;
    expect(slot).toMatchObject({ recording: false, streamerId: null });
    expect(sent.some((x) => x.type === "capture/target" && x.capture !== null)).toBe(false);

    await approvals.afterCheck(await getSettings());
    expect(notified.flat().map((a) => a.streamerName)).toEqual(["S1"]);
    await m.sync();
    slot = (await getSlots())[0]!;
    expect(slot).toMatchObject({ recording: false, waitingReason: expect.stringMatching(/Waiting for your approval/) });
    const snap = (await chrome.storage.local.get(SCHEDULER_KEY))[SCHEDULER_KEY] as SchedulerSnapshot;
    expect(snap.queue).toEqual([expect.objectContaining({ streamerId: 1, reason: "awaiting_approval" })]);

    await approvals.apply(approvalId(1, "twitch:b1"), "approve", await getSettings());
    await m.sync();
    expect((await getSlots())[0]).toMatchObject({ recording: true, streamerId: 1, channel: "s1" });

    // The stream restarts as a new broadcast: recording stops and you are asked again.
    await db.put("streamers", streamer(1, { broadcast_id: "twitch:b1-new" }));
    now = new Date(T0.getTime() + 60_000);
    await approvals.afterCheck(await getSettings());
    await m.sync();
    expect((await getSlots())[0]).toMatchObject({ recording: false, streamerId: null });
    expect(notified.flat().map((a) => a.broadcastId)).toEqual(["twitch:b1", "twitch:b1-new"]);
    // Answered and ended requests don't leave a stale notification behind.
    expect(cleared).toEqual([approvalId(1, "twitch:b1"), approvalId(1, "twitch:b1")]);
    expect((await getSlots())[0]!.message).toBe("S1 started a new broadcast; it needs your approval.");
    expect((await readApprovals()).map((a) => [a.broadcastId, a.status, a.endedAt === null])).toEqual([["twitch:b1-new", "pending", true], ["twitch:b1", "approved", false]]);
  });

  it("approved streams beyond the 3 slots wait in the queue with their position; declined ones are never recorded", async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) await db.put("streamers", streamer(id));
    const { d } = deps();
    const m = createCaptureManager(d);
    for (const tab of [10, 11, 12]) await m.arm(tab);
    await approvals.afterCheck(await getSettings());
    const s = await getSettings();
    for (const id of [1, 2, 3, 4, 5]) await approvals.apply(approvalId(id, `twitch:b${id}`), "approve", s);
    await approvals.apply(approvalId(6, "twitch:b6"), "decline", s);
    await m.sync();
    expect((await getSlots()).map((x) => x.streamerId).sort()).toEqual([1, 2, 3]);
    const snap = (await chrome.storage.local.get(SCHEDULER_KEY))[SCHEDULER_KEY] as SchedulerSnapshot;
    expect(snap.queue.map((q) => [q.streamerId, q.reason])).toEqual([[4, "waiting_for_slot"], [5, "waiting_for_slot"], [6, "declined"]]);
    expect(snap.queue[0]!.detail).toBe("Approved, #1 in the queue: all 3 slots busy.");
    expect(snap.queue[1]!.detail).toBe("Approved, #2 in the queue: all 3 slots busy.");

    // A recording ends (streamer 1 goes offline): the first queued approved stream takes the slot.
    await db.put("streamers", streamer(1, { is_live: false, broadcast_id: null }));
    now = new Date(T0.getTime() + 120_000);
    await approvals.afterCheck(await getSettings());
    await m.sync();
    expect((await getSlots()).map((x) => x.streamerId).sort()).toEqual([2, 3, 4]);

    // "Stop recording this stream" releases the slot to the next approved one.
    await approvals.apply(approvalId(2, "twitch:b2"), "stop", await getSettings());
    await m.sync();
    expect((await getSlots()).map((x) => x.streamerId).sort()).toEqual([3, 4, 5]);
  });

  it("the dashboard message applies decisions and reports closed requests in plain words", async () => {
    await db.put("streamers", streamer(1));
    await approvals.afterCheck(await getSettings());
    const base = await getSettings();
    const settings = { ...base, notifications: { ...base.notifications, remindMinutes: 5 } };
    const decideFn = (id: string, action: "approve" | "decline" | "remind" | "stop") => approvals.apply(id, action, settings);
    const manager = {} as MonitoringManager;
    const ok = await handleMessage({ type: "approval/decide", id: approvalId(1, "twitch:b1"), action: "remind" }, manager, undefined, undefined, decideFn);
    expect(ok).toMatchObject({ ok: true, data: { status: "snoozed", remindAt: new Date(T0.getTime() + 5 * 60_000).toISOString() } });
    expect(await handleMessage({ type: "approval/decide", id: approvalId(1, "twitch:b1"), action: "bogus" }, manager, undefined, undefined, decideFn)).toEqual({ ok: false, error: "Invalid request" });
    expect(await handleMessage({ type: "approval/decide", id: approvalId(1, "twitch:b1"), action: "stop" }, manager, undefined, undefined, decideFn)).toEqual({ ok: false, error: "Only an approved stream can be stopped." });
    expect(await handleMessage({ type: "approval/decide", id: "x", action: "approve" }, manager)).toMatchObject({ ok: false });
  });
});
