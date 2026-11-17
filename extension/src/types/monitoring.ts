/**
 * Monitoring status as shown to the user. These must always reflect reality:
 * - stopped:  the user has not enabled monitoring.
 * - starting: enabled, first live-status check not finished yet.
 * - active:   the latest check reached every platform on the monitoring list.
 * - degraded: some platform couldn't be checked (not set up, error, rate limit).
 * - offline:  no platform could be checked; retrying with backoff.
 */
export type MonitoringStatus = "stopped" | "starting" | "active" | "degraded" | "offline";

export interface MonitoringState {
  enabled: boolean;
  status: MonitoringStatus;
  /** ISO timestamps (UTC). */
  enabledAt: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Earliest time the next attempt may run (exponential backoff). */
  nextAttemptAt: string | null;
  /** Counts from the latest status check (null until the first one). */
  liveCount: number | null;
  activeSessions: number | null;
}

export const INITIAL_MONITORING_STATE: MonitoringState = {
  enabled: false,
  status: "stopped",
  enabledAt: null,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  liveCount: null,
  activeSessions: null,
};
