/**
 * Monitoring status as shown to the user. These must always reflect reality:
 * - stopped:  the user has not enabled monitoring.
 * - starting: enabled, first live-status check not finished yet.
 * - active:   the latest check reached every platform on the monitoring list.
 * - degraded: some platform couldn't be checked (not set up, error, rate limit).
 * - offline:  no platform could be checked; retrying with backoff.
 */
export type MonitoringStatus = "stopped" | "starting" | "active" | "degraded" | "offline";

export type BackendStatus = "unknown" | "online" | "offline";

export interface MonitoringState {
  enabled: boolean;
  status: MonitoringStatus;
  backendStatus: BackendStatus;
  /** Backend version reported by /api/v1/health, if known. */
  backendVersion: string | null;
  /** ISO timestamps (UTC). */
  enabledAt: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  /** When the backend lease expires, as reported by the backend. */
  leaseExpiresAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Earliest time the next attempt may run (exponential backoff). */
  nextAttemptAt: string | null;
  /** Counts reported by the latest heartbeat (null until the first one succeeds). */
  liveCount: number | null;
  activeSessions: number | null;
  /** Backend clock at the last heartbeat; sent back as `since` so notifications are not repeated. */
  lastServerTime: string | null;
}

export const INITIAL_MONITORING_STATE: MonitoringState = {
  enabled: false,
  status: "stopped",
  backendStatus: "unknown",
  backendVersion: null,
  enabledAt: null,
  lastCheckAt: null,
  lastSuccessAt: null,
  leaseExpiresAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  liveCount: null,
  activeSessions: null,
  lastServerTime: null,
};
