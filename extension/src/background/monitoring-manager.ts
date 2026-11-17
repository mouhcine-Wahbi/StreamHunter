import { ApiClient, ApiError } from "@/services/api-client";
import { getAuthToken, getMonitoringState, getSettings, patchMonitoringState } from "@/store/storage";
import type { MonitoringState } from "@/types/monitoring";
import { backoffDelayMs } from "@/utils/backoff";
import { syncAlarms } from "./alarm-manager";
import { notifyStreamEvents, type StreamNotification } from "./notifications";

import { db } from "@/local/db";
import { pauseActiveSessions, resumePausedSessions, syncSessions } from "@/local/sessions";
import { refreshStatuses, type RefreshResult } from "@/local/streamers";
import type { MonitoringSession, Streamer } from "@/types/api";

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
  /** One live-status check of the monitoring list against Twitch/Kick. */
  refresh: (at: Date) => Promise<RefreshResult>;
}

const defaultDeps: MonitoringDeps = {
  now: () => new Date(),
  createClient: (baseUrl) => new ApiClient({ baseUrl, getToken: getAuthToken }),
  refresh: (at) => refreshStatuses(undefined, at),
};

function liveNotification(s: MonitoringSession, streamer: Streamer | undefined): StreamNotification {
  return {
    type: "streamer_live",
    streamer_id: s.streamer_id,
    streamer_display_name: s.streamer_display_name ?? streamer?.display_name ?? "A streamer",
    platform: s.platform,
    title: streamer?.current_title ?? null,
    category: streamer?.current_category ?? null,
    at: s.started_at,
  };
}

/**
 * Drives background monitoring, entirely inside the extension. Each alarm runs one batched
 * live-status check of the monitoring list against Twitch and Kick (no video, no open tabs),
 * opens/ends sessions on live/offline transitions and notifies. All state is persisted after
 * every step, so a suspended/restarted service worker continues where it left off.
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

  async function runTick(force: boolean): Promise<MonitoringState> {
    const state = await getMonitoringState();
    if (!state.enabled) return state;

    const now = deps.now();
    if (!force && state.nextAttemptAt && new Date(state.nextAttemptAt) > now) {
      return state; // backing off (rate limit or repeated failures)
    }
    const settings = await getSettings();
    const at = now.toISOString();
    try {
      const r = await deps.refresh(now);
      const sync = await syncSessions(new Set(r.checked_ids), now);
      const problems = Object.entries(r.unavailable).map(([p, msg]) => `${p === "twitch" ? "Twitch" : "Kick"}: ${msg}`);
      const allFailed = r.checked === 0 && problems.length > 0;
      if (sync.opened.length > 0) {
        const streamers = await db.all<Streamer>("streamers");
        await notifyStreamEvents(sync.opened.map((x) => liveNotification(x, streamers.find((s) => s.id === x.streamer_id))), settings);
      }
      const waits = Object.values(r.retry_after);
      const failures = allFailed ? state.consecutiveFailures + 1 : 0;
      const backoff = allFailed ? backoffDelayMs(failures, { baseMs: settings.monitoring.intervalMinutes * 60_000 }) : 0;
      const wait = Math.max(backoff, waits.length ? Math.max(...waits) * 1000 : 0);
      return patchMonitoringState({
        status: allFailed ? "offline" : problems.length ? "degraded" : "active",
        backendStatus: "unknown",
        lastCheckAt: at,
        lastSuccessAt: allFailed ? state.lastSuccessAt : at,
        leaseExpiresAt: null,
        liveCount: r.live,
        activeSessions: sync.active,
        lastError: problems.length ? problems.join(" ") : null,
        consecutiveFailures: failures,
        nextAttemptAt: wait > 0 ? new Date(now.getTime() + wait).toISOString() : null,
      });
    } catch (err) {
      const failures = state.consecutiveFailures + 1;
      const delay = backoffDelayMs(failures, { baseMs: settings.monitoring.intervalMinutes * 60_000 });
      return patchMonitoringState({
        status: "offline",
        lastCheckAt: at,
        lastError: err instanceof Error ? err.message : "Unexpected error",
        consecutiveFailures: failures,
        nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
      });
    }
  }

  function tick(force = false): Promise<MonitoringState> {
    if (!inFlight) {
      inFlight = runTick(force).finally(() => {
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
    await resumePausedSessions();
    return tick(true);
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
    await pauseActiveSessions(deps.now());
    return state;
  }

  /** Called when the worker starts (browser startup / install / update). */
  async function restore(): Promise<MonitoringState> {
    const [state, settings] = await Promise.all([getMonitoringState(), getSettings()]);
    if (state.enabled && !settings.monitoring.resumeOnStartup) return stop();
    await syncAlarms(state.enabled, settings.monitoring.intervalMinutes);
    if (!state.enabled) return state;
    await patchMonitoringState({ status: "starting", nextAttemptAt: null });
    await resumePausedSessions();
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
