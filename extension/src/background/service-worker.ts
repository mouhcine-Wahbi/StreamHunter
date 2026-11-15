/**
 * StreamHunter background service worker (Manifest V3).
 *
 * The worker can be terminated at any moment. Rules followed here:
 *  - every listener is registered synchronously at top level;
 *  - no state is kept in memory between events (see store/storage.ts);
 *  - periodic work is driven by chrome.alarms, never setInterval.
 */
import { getMonitoringState, STORAGE_KEYS } from "@/store/storage";
import type { MonitoringState } from "@/types/monitoring";
import { sanitizeSettings } from "@/utils/settings";
import { ALARMS, syncAlarms } from "./alarm-manager";
import { renderBadge } from "./badge";
import { handleMessage, isTrustedSender } from "./message-handler";
import { createMonitoringManager } from "./monitoring-manager";
import { NOTIFICATION_PREFIX } from "./notifications";
import { syncSettingsToBackend } from "./settings-sync";

const manager = createMonitoringManager();

function log(event: string, data?: Record<string, unknown>) {
  console.info(JSON.stringify({ src: "streamhunter.sw", event, ...data }));
}

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", { reason: details.reason });
  void (async () => {
    await manager.restore();
    if (details.reason === "install") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("app.html#/overview") });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  log("browser_startup");
  void manager.restore();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.heartbeat) void manager.tick();
});

chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL("app.html#/monitoring") });
  void chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  handleMessage(message, manager).then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const monitoring = changes[STORAGE_KEYS.monitoring];
  if (monitoring?.newValue) void renderBadge(monitoring.newValue as MonitoringState);

  const settings = changes[STORAGE_KEYS.settings];
  if (settings) {
    const next = sanitizeSettings(settings.newValue);
    void getMonitoringState().then((s) => syncAlarms(s.enabled, next.monitoring.intervalMinutes));
  }
  // Keep the backend copy of settings in step (it uses retention and score thresholds).
  if (settings || changes[STORAGE_KEYS.authToken]?.newValue) void syncSettingsToBackend();
});

// The toolbar icon opens the popup; the side panel is opened explicitly from the popup.
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);

// Repaint the badge whenever the worker wakes up.
void getMonitoringState().then(renderBadge);
