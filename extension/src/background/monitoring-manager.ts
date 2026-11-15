import { ApiClient, ApiError } from "@/services/api-client";
import { getAuthToken, getMonitoringState, getSettings, patchMonitoringState } from "@/store/storage";
import type { MonitoringState } from "@/types/monitoring";
import { backoffDelayMs } from "@/utils/backoff";
import { syncAlarms } from "./alarm-manager";
import { notifyStreamEvents, type StreamNotification } from "./notifications";

export interface HeartbeatResponse {
  lease_expires_at: string;
  interval_seconds: number;
  started: boolean;
  active_sessions: number;
  live_count: number;
  notifications: StreamNotification[];
  server_time: string;
}

export interface MonitoringDeps {
  now: () => Date;
  createClient: (baseUrl: string) => ApiClient;
}

const defaultDeps: MonitoringDeps = {
  now: () => new Date(),
  createClient: (baseUrl) => new ApiClient({ baseUrl, getToken: getAuthToken }),
};

/**
 * Drives browser-based monitoring. All state is persisted after every step so
 * a suspended/restarted service worker continues where it left off.
 *
 * Contract with the backend (see ARCHITECTURE.md §2):
 *   POST /api/v1/monitoring/start     → grants a lease and checks the watchlist right away.
 *   POST /api/v1/monitoring/heartbeat → extends the lease while the browser is alive; returns
 *                                       "went live" notifications since the previous heartbeat.
 *   POST /api/v1/monitoring/stop      → releases the lease immediately (sessions pause).
 */
export function createMonitoringManager(deps: MonitoringDeps = defaultDeps) {
  // Single-flight guard: alarms and UI clicks can overlap within one worker lifetime.
  let inFlight: Promise<MonitoringState> | null = null;

  async function checkBackend(): Promise<MonitoringState> {
    const settings = await getSettings();
    const client = deps.createClient(settings.backendUrl);
    const at = deps.now().toISOString();
    try {
      const health = await client.health();
      return patchMonitoringState({
        backendStatus: "online",
        backendVersion: typeof health.version === "string" ? health.version : null,
        lastCheckAt: at,
      });
    } catch (err) {
      return patchMonitoringState({
        backendStatus: err instanceof ApiError && err.isHttp ? "online" : "offline",
        lastCheckAt: at,
        lastError: describeError(err),
      });
    }
  }

  async function runTick(force: boolean, path = "/api/v1/monitoring/heartbeat"): Promise<MonitoringState> {
    const state = await getMonitoringState();
    if (!state.enabled) return state;

    const now = deps.now();
    if (!force && state.nextAttemptAt && new Date(state.nextAttemptAt) > now) {
      return state; // still backing off
    }

    const settings = await getSettings();
    const client = deps.createClient(settings.backendUrl);
    const at = now.toISOString();

    try {
      const res = await client.post<HeartbeatResponse>(path, {
        client: "chrome-extension",
        interval_seconds: settings.monitoring.intervalMinutes * 60,
        since: state.lastServerTime,
      });
      await notifyStreamEvents(res.notifications ?? [], settings);
      return patchMonitoringState({
        status: "active",
        backendStatus: "online",
        lastCheckAt: at,
        lastSuccessAt: at,
        leaseExpiresAt: res.lease_expires_at ?? null,
        liveCount: res.live_count ?? null,
        activeSessions: res.active_sessions ?? null,
        lastServerTime: res.server_time ?? state.lastServerTime,
        lastError: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      });
    } catch (err) {
      const failures = state.consecutiveFailures + 1;
      const reachable = err instanceof ApiError && err.isHttp;
      const delay = backoffDelayMs(failures, { baseMs: settings.monitoring.intervalMinutes * 60_000 });
      return patchMonitoringState({
        status: reachable ? "degraded" : "offline",
        backendStatus: reachable ? "online" : "offline",
        lastCheckAt: at,
        leaseExpiresAt: null,
        lastError: describeError(err),
        consecutiveFailures: failures,
        nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
      });
    }
  }

  function tick(force = false, path?: string): Promise<MonitoringState> {
    if (!inFlight) {
      inFlight = runTick(force, path).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function start(): Promise<MonitoringState> {
    const settings = await getSettings();
    await patchMonitoringState({
      enabled: true,
      status: "starting",
      enabledAt: deps.now().toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });
    await syncAlarms(true, settings.monitoring.intervalMinutes);
    await checkBackend(); // records reachability + backend version for the UI
    return tick(true, "/api/v1/monitoring/start");
  }

  async function stop(): Promise<MonitoringState> {
    const settings = await getSettings();
    await syncAlarms(false, settings.monitoring.intervalMinutes);
    const state = await patchMonitoringState({
      enabled: false,
      status: "stopped",
      enabledAt: null,
      leaseExpiresAt: null,
      activeSessions: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    // Best effort: release the backend lease now instead of waiting for it to expire.
    deps
      .createClient(settings.backendUrl)
      .post("/api/v1/monitoring/stop")
      .catch(() => undefined);
    return state;
  }

  /** Called when the worker starts (browser startup / install / update). */
  async function restore(): Promise<MonitoringState> {
    const [state, settings] = await Promise.all([getMonitoringState(), getSettings()]);
    if (state.enabled && !settings.monitoring.resumeOnStartup) return stop();
    await syncAlarms(state.enabled, settings.monitoring.intervalMinutes);
    if (!state.enabled) return state;
    await patchMonitoringState({ status: "starting", nextAttemptAt: null });
    return tick(true);
  }

  return { start, stop, tick, restore, checkBackend };
}

export type MonitoringManager = ReturnType<typeof createMonitoringManager>;

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "network":
        return "Backend unreachable. Is the StreamHunter backend running and is the URL correct?";
      case "timeout":
        return "Backend did not respond in time.";
      case "parse":
        return "Backend returned an unexpected response.";
      case "http":
        if (err.status === 401) return "Not signed in to StreamHunter (401).";
        if (err.status === 404) return "This backend does not provide the monitoring endpoint (404).";
        return `Backend error ${err.status}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : "Unknown error";
}
