import { createMonitoringManager } from "./monitoring-manager";
import { ALARMS, syncAlarms } from "./alarm-manager";
import { ApiClient } from "@/services/api-client";
import { getMonitoringState, updateSettings } from "@/store/storage";
import { json, mockFetch } from "@/test/http";

function setup(now = new Date("2026-11-13T10:00:00Z")) {
  let clock = now;
  const manager = createMonitoringManager({
    now: () => clock,
    createClient: (baseUrl) => new ApiClient({ baseUrl }),
  });
  return {
    manager,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const heartbeatOk = (url: string) =>
  url.endsWith("/api/v1/monitoring/heartbeat")
    ? json({ lease_expires_at: "2026-11-13T10:06:00Z" })
    : url.endsWith("/api/v1/monitoring/stop")
      ? json({ ok: true })
      : json({ status: "ok", version: "0.1.0" });

describe("monitoring manager", () => {
  it("start: schedules the heartbeat alarm and becomes active when the backend grants a lease", async () => {
    const fetch = mockFetch(heartbeatOk);
    const { manager } = setup();
    const state = await manager.start();
    expect(state).toMatchObject({ enabled: true, status: "active", backendStatus: "online", leaseExpiresAt: "2026-11-13T10:06:00Z" });
    const alarm = fakeChrome.internals.alarms.get(ALARMS.heartbeat);
    expect(alarm?.periodInMinutes).toBe(2);
    expect(state.backendVersion).toBe("0.1.0");
    const hb = fetch.mock.calls.find(([u]) => String(u).endsWith("/api/v1/monitoring/heartbeat"))!;
    expect(JSON.parse(String(hb[1]!.body))).toEqual({ client: "chrome-extension", interval_seconds: 120 });
  });

  it("goes offline with exponential backoff when the backend is unreachable", async () => {
    mockFetch(() => null);
    const { manager, advance } = setup();
    let state = await manager.start();
    expect(state).toMatchObject({ status: "offline", backendStatus: "offline", consecutiveFailures: 1 });
    expect(state.nextAttemptAt).toBe("2026-11-13T10:02:00.000Z");

    // An alarm firing before the backoff elapses does nothing.
    advance(60_000);
    state = await manager.tick();
    expect(state.consecutiveFailures).toBe(1);

    advance(60_000);
    state = await manager.tick();
    expect(state.consecutiveFailures).toBe(2);
    expect(state.nextAttemptAt).toBe("2026-11-13T10:06:00.000Z");
  });

  it("reports degraded (not active) when the backend lacks the monitoring endpoint", async () => {
    mockFetch(() => json({ detail: "Not Found" }, 404));
    const { manager } = setup();
    const state = await manager.start();
    expect(state.status).toBe("degraded");
    expect(state.backendStatus).toBe("online");
    expect(state.lastError).toMatch(/does not provide the monitoring endpoint/);
  });

  it("recovers to active and resets failures after the backend comes back", async () => {
    let up = false;
    mockFetch((url) => (up ? heartbeatOk(url) : null));
    const { manager, advance } = setup();
    await manager.start();
    up = true;
    advance(5 * 60_000);
    const state = await manager.tick();
    expect(state).toMatchObject({ status: "active", consecutiveFailures: 0, lastError: null, nextAttemptAt: null });
  });

  it("stop: clears the alarm, resets state and releases the lease", async () => {
    const fetch = mockFetch(heartbeatOk);
    const { manager } = setup();
    await manager.start();
    const state = await manager.stop();
    expect(state).toMatchObject({ enabled: false, status: "stopped", leaseExpiresAt: null });
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(false);
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/api/v1/monitoring/stop"))).toBe(true);
  });

  it("restore after a worker restart resumes from persisted state", async () => {
    mockFetch(heartbeatOk);
    await setup().manager.start();
    // Simulate Chrome restart: alarms are gone, memory is gone, storage survives.
    fakeChrome.internals.alarms.clear();
    fakeChrome.internals.dropListeners();
    const fresh = setup(new Date("2026-11-13T12:00:00Z")).manager;
    const state = await fresh.restore();
    expect(state).toMatchObject({ enabled: true, status: "active", lastSuccessAt: "2026-11-13T12:00:00.000Z" });
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(true);
  });

  it("restore stops monitoring when resume-on-startup is disabled", async () => {
    mockFetch(heartbeatOk);
    await setup().manager.start();
    await updateSettings({ monitoring: { resumeOnStartup: false } });
    const state = await setup().manager.restore();
    expect(state.enabled).toBe(false);
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(false);
  });

  it("restore does nothing when monitoring was off", async () => {
    const fetch = mockFetch(heartbeatOk);
    const state = await setup().manager.restore();
    expect(state.status).toBe("stopped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("concurrent ticks share one request", async () => {
    const fetch = mockFetch(heartbeatOk);
    const { manager } = setup();
    await manager.start();
    fetch.mockClear();
    await Promise.all([manager.tick(true), manager.tick(true), manager.tick(true)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checkBackend updates backend status without enabling monitoring", async () => {
    mockFetch(heartbeatOk);
    const state = await setup().manager.checkBackend();
    expect(state).toMatchObject({ enabled: false, backendStatus: "online", backendVersion: "0.1.0" });
    expect((await getMonitoringState()).status).toBe("stopped");
  });
});

describe("syncAlarms", () => {
  it("re-creates the alarm only when the interval changes", async () => {
    await syncAlarms(true, 2);
    const first = fakeChrome.internals.alarms.get(ALARMS.heartbeat);
    await syncAlarms(true, 2);
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)).toBe(first);
    await syncAlarms(true, 5);
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)?.periodInMinutes).toBe(5);
    await syncAlarms(false, 5);
    expect(fakeChrome.internals.alarms.size).toBe(0);
  });
});
