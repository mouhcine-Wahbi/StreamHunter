import { approveAllLive } from "@/test/approvals";
import { db } from "@/local/db";
import { enforceStorageLimits, listClips, saveClip, updateClip } from "@/local/clips";
import { filterClips } from "@/local/local-api";
import { patchMonitoringState } from "@/store/storage";
import type { MonitoringSession, Streamer } from "@/types/api";
import { INITIAL_CAPTURE_STATE } from "@/types/capture";
import type { OffscreenRequest } from "@/types/messages";
import { videoStage } from "@/components/monitoring/PipelineStatus";
import { createCaptureManager, getCaptureState, pickRecordingTarget, type CaptureDeps } from "./capture-manager";

const NOW = Date.parse("2026-11-18T12:00:00Z");

function streamer(id: number, over: Partial<Streamer> = {}): Streamer {
  return {
    id, platform: "twitch", platform_user_id: String(id), username: `s${id}`, display_name: `S${id}`, profile_image_url: null, is_live: true,
    current_title: null, current_category: "Just Chatting", viewer_count: 100 * id, stream_started_at: "2026-11-18T10:00:00Z", status_checked_at: null,
    monitoring_enabled: true, is_favorite: false, auto_record: true, updated_at: "", ...over,
  };
}

function deps() {
  const sent: OffscreenRequest[] = [];
  const navigations: string[] = [];
  const d: CaptureDeps = {
    approvals: approveAllLive,
    now: () => NOW,
    streamIdFor: vi.fn(async () => "stream-1"),
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    toOffscreen: vi.fn(async (m: OffscreenRequest) => {
      sent.push(m);
      return { ok: true };
    }),
    notify: async () => undefined,
    navigate: vi.fn(async (_tab: number, url: string) => void navigations.push(url)),
  };
  return { d, sent, navigations };
}

describe("recorder tab (automatic recording)", () => {
  it("picks the live Auto-record streamer (favourite, then most viewers) and keeps it while live", () => {
    const list = [streamer(1), streamer(2), streamer(3, { auto_record: false }), streamer(4, { is_live: false }), streamer(5, { monitoring_enabled: false })];
    expect(pickRecordingTarget(list, null)?.id).toBe(2);
    expect(pickRecordingTarget(list.map((s) => (s.id === 1 ? { ...s, is_favorite: true } : s)), null)?.id).toBe(1);
    expect(pickRecordingTarget(list, 1)?.id).toBe(1); // no flapping to a bigger stream
    expect(pickRecordingTarget([streamer(4, { is_live: false })], null)).toBeNull();
  });

  it("arms once, then follows who is live: switches channel, waits, reloads on a restart, pauses", async () => {
    await patchMonitoringState({ enabled: true, status: "active" });
    await db.put("streamers", streamer(1));
    await db.put("streamers", streamer(2, { is_live: false }));
    const { d, sent, navigations } = deps();
    const m = createCaptureManager(d);

    let s = await m.arm(9);
    expect(d.streamIdFor).toHaveBeenCalledWith(9);
    expect(sent[0]).toMatchObject({ type: "capture/start", capture: null });
    expect(navigations).toEqual(["https://www.twitch.tv/s1"]);
    expect(sent.at(-1)).toMatchObject({ type: "capture/target", capture: { streamerId: 1, displayName: "S1", category: "Just Chatting" } });
    expect(s).toMatchObject({ mode: "recorder", status: "capturing", recording: true, streamerId: 1, channel: "s1", tabId: 9 });

    // S1 goes offline, S2 goes live → the recorder switches.
    await db.put("streamers", streamer(1, { is_live: false }));
    await db.put("streamers", streamer(2));
    s = await m.sync();
    expect(navigations.at(-1)).toBe("https://www.twitch.tv/s2");
    expect(s).toMatchObject({ recording: true, streamerId: 2, message: expect.stringMatching(/^S2 gets this slot \(priority \d+\)\.$/) });

    // Nobody live → stop encoding, say why.
    await db.put("streamers", streamer(2, { is_live: false }));
    s = await m.sync();
    expect(sent.at(-1)).toEqual({ target: "offscreen", type: "capture/target", slot: 9, capture: null });
    expect(s).toMatchObject({ recording: false, streamerId: null, waitingReason: "Waiting for an approved live stream. StreamHunter asks you when a selected streamer goes live." });

    // S2 restarts: live with a session, then a new session → the player is reloaded.
    await db.put("streamers", streamer(2));
    await db.put<MonitoringSession>("sessions", { id: undefined as unknown as number, streamer_id: 2, status: "active", started_at: "", broadcast_started_at: "2026-11-18T11:00:00Z" } as MonitoringSession);
    await m.sync();
    const before = navigations.length;
    const [old] = await db.all<MonitoringSession>("sessions");
    await db.put("sessions", { ...old!, status: "ended" });
    await db.put<MonitoringSession>("sessions", { id: undefined as unknown as number, streamer_id: 2, status: "active", started_at: "", broadcast_started_at: "2026-11-18T11:30:00Z" } as MonitoringSession);
    s = await m.sync();
    expect(navigations.length).toBe(before + 1);
    expect(s.message).toBe("S2 restarted the stream; recording again.");

    // Pause / resume.
    s = await m.setPaused(true);
    expect(sent.at(-1)).toEqual({ target: "offscreen", type: "capture/pause", slot: 9, paused: true });
    expect(s).toMatchObject({ paused: true, recording: false });
    s = await m.setPaused(false);
    expect(s).toMatchObject({ paused: false, recording: true });

    // Monitoring stopped → nothing is recorded.
    await patchMonitoringState({ enabled: false, status: "stopped" });
    s = await m.sync();
    expect(s).toMatchObject({ recording: false, waitingReason: "Monitoring is stopped. Start monitoring to record automatically." });
  });

  it("says when the recorder tab is gone, and tries to restart a failed engine on the same tab", async () => {
    await patchMonitoringState({ enabled: true, status: "active" });
    const { d } = deps();
    const m = createCaptureManager(d);
    await m.arm(9);
    await m.onEnded(9, "Video encoding failed");
    expect(await getCaptureState()).toMatchObject({ status: "capturing", mode: "recorder", message: "Capture restarted (Video encoding failed)." });
    d.streamIdFor = vi.fn(async () => Promise.reject(new Error("Extension has not been invoked")));
    await m.onEnded(9, "Video encoding failed");
    expect((await getCaptureState()).status).toBe("off");
    expect((await getCaptureState()).message).toMatch(/Video capture is inactive/);
    await m.arm(9).catch(() => undefined);
    await m.onTabRemoved(9);
  });

  it("is honest in the pipeline: a live Auto-record streamer without a recorder is 'detected, video inactive'", () => {
    expect(videoStage([], [streamer(1)])).toMatchObject({ tone: "danger", state: "Inactive" });
    expect(videoStage([], [streamer(1)]).detail).toMatch(/S1 is live and detected, but video capture is inactive/);
    expect(videoStage([], [])).toMatchObject({ state: "Off" });
    expect(videoStage([{ ...INITIAL_CAPTURE_STATE, status: "capturing", mode: "recorder", recording: false, waitingReason: "Waiting" }], [])).toMatchObject({ state: "Armed, waiting" });
    expect(videoStage([{ ...INITIAL_CAPTURE_STATE, status: "capturing", recording: true, channel: "s1", silentSeconds: 25 }], []).detail).toMatch(/muted/);
    // Several slots: count them, and name live streamers nobody records.
    const rec = (id: number) => ({ ...INITIAL_CAPTURE_STATE, status: "capturing" as const, mode: "recorder" as const, recording: true, tabId: id, streamerId: id, channel: `s${id}`, bufferedSeconds: 60 });
    const multi = videoStage([rec(1), rec(2)], [streamer(1), streamer(2), streamer(3)], 2);
    expect(multi).toMatchObject({ tone: "live", state: "Recording 2" });
    expect(multi.detail).toMatch(/2 of 2 slots: s1 \(60 s buffered\), s2 \(60 s buffered\)\. S3 is live but not recorded \(all 2 recorder slots in use\)/);
  });
});

describe("clip storage", () => {
  const add = (i: number, mb: number, over: { createdDaysAgo?: number } = {}) =>
    saveClip({ candidateId: i, sessionId: null, streamerId: i % 2, streamerName: `S${i}`, platform: i % 2 ? "twitch" : "kick", title: `c${i}`, startedAt: NOW,
      durationSec: 10 * i, width: 2, height: 2, score: 10 * i, blob: new Blob([new Uint8Array(mb * 1_048_576)]), category: i % 2 ? "Chess" : "IRL",
      detectionTypes: i % 2 ? ["audio", "chat"] : ["visual"] }).then(async (c) => {
      if (over.createdDaysAgo) await db.put("clips", { ...c, created_at: new Date(NOW - over.createdDaysAgo * 86_400_000).toISOString() });
      return c;
    });

  it("deletes the oldest clips over the size limit and clips past the age limit, never favourites", async () => {
    const a = await add(1, 2, { createdDaysAgo: 40 });
    const b = await add(2, 2, { createdDaysAgo: 3 });
    const c = await add(3, 2, { createdDaysAgo: 2 });
    await add(4, 2, { createdDaysAgo: 1 });
    await updateClip(a.id, { favorite: true });
    let r = await enforceStorageLimits({ maxTotalMb: 5, maxAgeDays: 0 }, new Date(NOW));
    expect(r.deleted).toEqual([b.id, c.id]); // oldest non-favourites until ≤ 5 MB
    expect(await db.get("clipBlobs", b.id)).toBeUndefined();
    r = await enforceStorageLimits({ maxTotalMb: 100, maxAgeDays: 30 }, new Date(NOW));
    expect(r.deleted).toEqual([]); // the 40-day-old clip is a favourite
    await updateClip(a.id, { favorite: false });
    r = await enforceStorageLimits({ maxTotalMb: 100, maxAgeDays: 30 }, new Date(NOW));
    expect(r.deleted).toEqual([a.id]);
    expect((await listClips()).map((x) => x.title)).toEqual(["c4"]);
  });

  it("filters clips by streamer, platform, category, duration and detection type, and ranks by score", async () => {
    for (let i = 1; i <= 8; i++) await add(i, 0);
    const all = await listClips();
    const q = (s: string) => filterClips(all, new URLSearchParams(s)).map((c) => c.title);
    expect(q("sort=score")).toEqual(["c8", "c7", "c6", "c5", "c4", "c3", "c2", "c1"]);
    expect(q("platform=kick&sort=score")).toEqual(["c8", "c6", "c4", "c2"]);
    expect(q("category=Chess&type=chat&sort=score")).toEqual(["c7", "c5", "c3", "c1"]);
    expect(q("duration=short&sort=score")).toEqual(["c2", "c1"]);
    expect(q("duration=long&sort=score")).toEqual(["c8", "c7", "c6"]);
    expect(q("streamer_id=0&type=visual&sort=score")).toEqual(["c8", "c6", "c4", "c2"]);
  });
});
