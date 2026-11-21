export const ALARMS = {
  heartbeat: "sh-heartbeat",
  discovery: "sh-discovery",
  /** Every 5 minutes: resumes the processing queue left by a closed browser or document. */
  maintenance: "sh-maintenance",
} as const;

/** Content discovery runs every N hours (0 = only when you click Run). */
export async function syncDiscoveryAlarm(enabled: boolean, hours: number): Promise<void> {
  const existing = await chrome.alarms.get(ALARMS.discovery);
  const period = hours * 60;
  if (!enabled || hours <= 0) {
    if (existing) await chrome.alarms.clear(ALARMS.discovery);
    return;
  }
  if (existing && existing.periodInMinutes === period) return;
  if (existing) await chrome.alarms.clear(ALARMS.discovery);
  await chrome.alarms.create(ALARMS.discovery, { delayInMinutes: 1, periodInMinutes: period });
}

/** Maintenance: resumes the processing queue every 5 minutes while Chrome is open. */
export async function syncMaintenanceAlarm(): Promise<void> {
  // 3.0 builds before publishing was removed used "sh-publishing" for the same timer.
  await chrome.alarms.clear("sh-publishing").catch(() => false);
  if (!(await chrome.alarms.get(ALARMS.maintenance))) await chrome.alarms.create(ALARMS.maintenance, { delayInMinutes: 1, periodInMinutes: 5 });
}

/**
 * Makes the registered alarms match the desired monitoring state. Idempotent:
 * safe to call on every worker start, settings change and state change.
 * An existing alarm with the right period is left alone so its schedule is not reset.
 */
export async function syncAlarms(enabled: boolean, intervalMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(ALARMS.heartbeat);
  if (!enabled) {
    if (existing) await chrome.alarms.clear(ALARMS.heartbeat);
    return;
  }
  if (existing && existing.periodInMinutes === intervalMinutes) return;
  if (existing) await chrome.alarms.clear(ALARMS.heartbeat);
  await chrome.alarms.create(ALARMS.heartbeat, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes,
  });
}
