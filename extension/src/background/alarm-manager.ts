export const ALARMS = {
  heartbeat: "sh-heartbeat",
  discovery: "sh-discovery",
  publishing: "sh-publishing",
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

/** Publishing queue: retries and status checks every 5 minutes while Chrome is open. */
export async function syncPublishingAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARMS.publishing))) await chrome.alarms.create(ALARMS.publishing, { delayInMinutes: 1, periodInMinutes: 5 });
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
