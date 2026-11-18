import { createMonitoringManager } from "./monitoring-manager";
import { ALARMS, syncAlarms } from "./alarm-manager";
import { getMonitoringState, updateSettings } from "@/store/storage";
import { json } from "@/test/http";
import { configurePlatforms, fakePlatforms, type FakeChannel } from "@/test/platforms";
import { LocalApi } from "@/local/local-api";
import { listSessions } from "@/local/sessions";
import { refreshStatuses } from "@/local/streamers";

function setup(now = new Date("2026-11-13T10:00:00Z")) {
  let clock = now;
  const manager = createMonitoringManager({
    now: () => clock,
    refresh: (at) => refreshStatuses(undefined, at),
  });
  return {
    manager,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function watch(...names: [platform: "twitch" | "kick", username: string][]) {
  const api = new LocalApi();
  for (const [platform, username] of names) await api.post("/api/v1/streamers", { platform, username });
}

describe("monitoring manager (local: no backend)", () => {
  it("start: schedules the alarm, checks the list and opens a session per live streamer", async () => {
    await configurePlatforms();
    const twitch: FakeChannel[] = [{ id: "1", login: "alpha", live: true, viewers: 10, title: "hi", game: "Chess" }, { id: "2", login: "beta" }];
    const { calls } = fakePlatforms({ twitch });
    await watch(["twitch", "alpha"], ["twitch", "beta"]);
    calls.length = 0;
    const { manager } = setup();
    const state = await manager.start();
    expect(state).toMatchObject({ enabled: true, status: "active", liveCount: 1, activeSessions: 1, lastError: null });
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)?.periodInMinutes).toBe(2);
    expect(calls).toEqual(["twitch /helix/streams?user_id=1&user_id=2&first=100"]); // one batched request, no backend
    const [session] = await listSessions();
    expect(session).toMatchObject({ streamer_display_name: "alpha", status: "active", platform: "twitch", broadcast_started_at: "2026-11-17T10:00:00.000Z" });
  });

  it("pause stops checks and sessions without losing the setup; resume picks up again", async () => {
    await configurePlatforms();
    const { calls } = fakePlatforms({ twitch: [{ id: "1", login: "alpha", live: true, viewers: 10 }] });
    await watch(["twitch", "alpha"]);
    const { manager } = setup();
    await manager.start();
    calls.length = 0;
    expect(await manager.pause()).toMatchObject({ enabled: true, paused: true, status: "paused" });
    expect((await listSessions())[0]!.status).toBe("paused");
    expect(await manager.tick(true)).toMatchObject({ status: "paused" });
    expect(calls).toEqual([]); // no API calls while paused
    expect(await manager.restore()).toMatchObject({ status: "paused" }); // a worker restart keeps the pause
    expect(await manager.resume()).toMatchObject({ enabled: true, paused: false, status: "active" });
    expect((await listSessions())[0]!.status).toBe("active");
    expect(await manager.stop()).toMatchObject({ enabled: false, paused: false, status: "stopped" });
  });

  it("ends the session when the streamer goes offline, and notifies go-lives when enabled", async () => {
    await configurePlatforms();
    await updateSettings({ notifications: { onStreamerLive: true } });
    const twitch: FakeChannel[] = [{ id: "1", login: "alpha", name: "Alpha", title: "ranked", game: "Valorant" }];
    fakePlatforms({ twitch });
    await watch(["twitch", "alpha"]);
    const { manager, advance } = setup();
    await manager.start();
    expect(await listSessions()).toEqual([]);

    twitch[0]!.live = true;
    advance(120_000);
    await manager.tick();
    expect(fakeChrome.internals.notifications).toEqual([
      expect.objectContaining({ title: "Alpha is live on Twitch", message: "ranked · Valorant" }),
    ]);
    advance(120_000);
    await manager.tick(); // still live: same session, no second notification
    expect(fakeChrome.internals.notifications).toHaveLength(1);
    expect((await listSessions()).map((s) => s.status)).toEqual(["active"]);

    twitch[0]!.live = false;
    advance(120_000);
    const state = await manager.tick();
    expect((await listSessions()).map((s) => s.status)).toEqual(["ended"]);
    expect(state).toMatchObject({ liveCount: 0, activeSessions: 0 });
  });

  it("is degraded when one platform can't be checked, and keeps that platform's sessions", async () => {
    await configurePlatforms();
    const twitch: FakeChannel[] = [{ id: "1", login: "alpha", live: true }];
    const kick: FakeChannel[] = [{ id: "7", login: "kk", live: true }];
    fakePlatforms({ twitch, kick });
    await watch(["twitch", "alpha"], ["kick", "kk"]);
    const { manager, advance } = setup();
    await manager.start();
    fakePlatforms({ twitch, kick, failWith: { kick: 500 } });
    advance(120_000);
    const state = await manager.tick();
    expect(state).toMatchObject({ status: "degraded", lastError: "Kick: Kick answered HTTP 500.", activeSessions: 2 });
    expect((await listSessions()).every((s) => s.status === "active")).toBe(true);
  });

  it("waits as long as the platform asks after a rate limit", async () => {
    await configurePlatforms();
    fakePlatforms({ twitch: [{ id: "1", login: "alpha" }] });
    await watch(["twitch", "alpha"]);
    const { fetch } = fakePlatforms({});
    fetch.mockImplementation(async (input) =>
      String(input).includes("id.twitch.tv")
        ? json({ access_token: "t", expires_in: 3600 })
        : new Response("{}", { status: 429, headers: { "Retry-After": "300" } }),
    );
    const { manager, advance } = setup();
    let state = await manager.start();
    expect(state).toMatchObject({ status: "offline", consecutiveFailures: 1, nextAttemptAt: "2026-11-13T10:05:00.000Z" });
    advance(120_000);
    fetch.mockClear();
    state = await manager.tick(); // an alarm before the wait is over does nothing
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains what to set up when no platform is configured", async () => {
    fakePlatforms({});
    await chrome.storage.local.set({});
    const { db } = await import("@/local/db");
    await db.put("streamers", { platform: "kick", platform_user_id: "9", username: "kk", display_name: "kk", monitoring_enabled: true, is_live: null } as never);
    const state = await setup().manager.start();
    expect(state.status).toBe("offline");
    expect(state.lastError).toMatch(/Add your Kick app's client ID and secret/);
  });

  it("stop: clears the alarm and pauses sessions; start resumes them if still the same broadcast", async () => {
    await configurePlatforms();
    fakePlatforms({ twitch: [{ id: "1", login: "alpha", live: true }] });
    await watch(["twitch", "alpha"]);
    const { manager } = setup();
    await manager.start();
    const stopped = await manager.stop();
    expect(stopped).toMatchObject({ enabled: false, status: "stopped" });
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(false);
    expect((await listSessions()).map((s) => s.status)).toEqual(["paused"]);
    await manager.start();
    expect((await listSessions()).map((s) => s.status)).toEqual(["active"]);
  });

  it("restore after a worker restart resumes from persisted state", async () => {
    await configurePlatforms();
    fakePlatforms({ twitch: [] });
    const { manager } = setup();
    await manager.start();
    const restored = await createMonitoringManager({ now: () => new Date(), refresh: (at) => refreshStatuses(undefined, at) }).restore();
    expect(restored).toMatchObject({ enabled: true, status: "active" });
  });

  it("restore stops monitoring when resume-on-startup is disabled", async () => {
    fakePlatforms({});
    await setup().manager.start();
    await updateSettings({ monitoring: { resumeOnStartup: false } });
    expect(await setup().manager.restore()).toMatchObject({ enabled: false, status: "stopped" });
  });

  it("concurrent ticks share one check", async () => {
    const refresh = vi.fn(async () => ({ checked: 0, live: 0, skipped_recent: 0, unavailable: {}, retry_after: {}, changes: [], checked_ids: [], spikes: [] }));
    const manager = createMonitoringManager({ now: () => new Date(), refresh });
    await chrome.storage.local.set({ "sh.monitoring": { enabled: true, status: "active" } });
    await Promise.all([manager.tick(true), manager.tick(true), manager.tick(true)]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-creates the alarm only when the interval changes", async () => {
    await syncAlarms(true, 2);
    const first = fakeChrome.internals.alarms.get(ALARMS.heartbeat);
    await syncAlarms(true, 2);
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)).toBe(first);
    await syncAlarms(true, 5);
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)?.periodInMinutes).toBe(5);
    await syncAlarms(false, 5);
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(false);
    expect((await getMonitoringState()).enabled).toBe(false);
  });
});
