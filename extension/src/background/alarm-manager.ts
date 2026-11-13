export const ALARMS = {
  heartbeat: "sh-heartbeat",
} as const;

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
