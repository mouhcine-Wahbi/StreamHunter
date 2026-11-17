import { ALARMS } from "./alarm-manager";
import { STORAGE_KEYS, getMonitoringState, updateSettings } from "@/store/storage";
import { json, mockFetch } from "@/test/http";
import { handleMessage, isTrustedSender } from "./message-handler";
import { createMonitoringManager } from "./monitoring-manager";
import { configurePlatforms, fakePlatforms } from "@/test/platforms";
import { LocalApi } from "@/local/local-api";

const okBackend = (url: string) =>
  /\/(heartbeat|start)$/.test(url)
    ? json({ lease_expires_at: "2026-11-13T10:06:00Z", interval_seconds: 120, started: true, active_sessions: 0, live_count: 0, notifications: [], server_time: "2026-11-13T10:00:00Z" })
    : json({ status: "ok", version: "0.1.0" });

async function loadWorker() {
  vi.resetModules();
  await import("./service-worker");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("service worker wiring", () => {
  it("handles start/stop messages from extension pages", async () => {
    mockFetch(okBackend);
    await loadWorker();
    const started = (await chrome.runtime.sendMessage({ type: "monitoring/start" })) as { ok: boolean; data: { status: string } };
    expect(started).toMatchObject({ ok: true, data: { status: "active" } });
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(true);

    const stopped = await chrome.runtime.sendMessage({ type: "monitoring/stop" });
    expect(stopped).toMatchObject({ ok: true, data: { status: "stopped" } });
  });

  it("runs a live-status check (no backend) when the alarm fires", async () => {
    await configurePlatforms();
    const { fetch } = fakePlatforms({ twitch: [{ id: "1", login: "alpha", live: true }] });
    await new LocalApi({ baseUrl: "http://localhost:8000" }).post("/api/v1/streamers", { platform: "twitch", username: "alpha" });
    await loadWorker();
    await chrome.runtime.sendMessage({ type: "monitoring/start" });
    fetch.mockClear();
    // Force the next tick to be due.
    const s = await getMonitoringState();
    await chrome.storage.local.set({ [STORAGE_KEYS.monitoring]: { ...s, nextAttemptAt: null } });
    fakeChrome.internals.fireAlarm(ALARMS.heartbeat);
    await flush();
    await flush();
    expect(fetch.mock.calls.some(([u]) => String(u).startsWith("https://api.twitch.tv/helix/streams?user_id=1"))).toBe(true);
    expect(fetch.mock.calls.some(([u]) => String(u).startsWith("http://localhost:8000"))).toBe(false);
  });

  it("re-schedules the alarm when the interval setting changes", async () => {
    mockFetch(okBackend);
    await loadWorker();
    await chrome.runtime.sendMessage({ type: "monitoring/start" });
    await updateSettings({ monitoring: { intervalMinutes: 10 } });
    await flush();
    await flush();
    expect(fakeChrome.internals.alarms.get(ALARMS.heartbeat)?.periodInMinutes).toBe(10);
  });

  it("restores monitoring on browser startup", async () => {
    mockFetch(okBackend);
    await chrome.storage.local.set({ [STORAGE_KEYS.monitoring]: { enabled: true, status: "active" } });
    await loadWorker();
    (chrome.runtime.onStartup as unknown as { emit: () => void }).emit();
    await flush();
    await flush();
    expect(fakeChrome.internals.alarms.has(ALARMS.heartbeat)).toBe(true);
  });

  it("opens the full workspace on first install", async () => {
    mockFetch(okBackend);
    await loadWorker();
    (chrome.runtime.onInstalled as unknown as { emit: (d: unknown) => void }).emit({ reason: "install" });
    await flush();
    await flush();
    expect(fakeChrome.internals.createdTabs).toEqual(["chrome-extension://streamhunter-test-id/app.html#/overview"]);
  });
});

describe("message handler", () => {
  const manager = () => createMonitoringManager();

  it("rejects unknown messages", async () => {
    expect(await handleMessage({ type: "evil" }, manager())).toEqual({ ok: false, error: "Unknown message" });
    expect(await handleMessage(null, manager())).toMatchObject({ ok: false });
  });

  it("only allows safe routes when opening the app", async () => {
    await handleMessage({ type: "app/open", route: "javascript:alert(1)" }, manager());
    await handleMessage({ type: "app/open", route: "/settings" }, manager());
    expect(fakeChrome.internals.createdTabs).toEqual([
      "chrome-extension://streamhunter-test-id/app.html#/overview",
      "chrome-extension://streamhunter-test-id/app.html#/settings",
    ]);
  });

  it("check-now without monitoring only checks backend health", async () => {
    mockFetch(okBackend);
    const res = await handleMessage({ type: "monitoring/check-now" }, manager());
    expect(res).toMatchObject({ ok: true, data: { enabled: false, backendStatus: "online" } });
  });

  it("trusts only this extension as sender", () => {
    expect(isTrustedSender({ id: "streamhunter-test-id" })).toBe(true);
    expect(isTrustedSender({ id: "other-extension" })).toBe(false);
  });
});
