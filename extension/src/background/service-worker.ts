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
import { HIGHLIGHT_PREFIX, NOTIFICATION_PREFIX, notifyHighlight } from "./notifications";
import { createChatManager } from "./chat-manager";
import { db } from "@/local/db";
import { streamUrl } from "@/local/streamers";
import { TWITCH_USER_KEY } from "@/platforms/twitch-user";
import { getSettings } from "@/store/storage";
import type { LocalHighlight } from "@/local/highlights";
import type { Streamer } from "@/types/api";
import { createCaptureManager, defaultCaptureDeps } from "./capture-manager";
import { updateClip, type LocalClip } from "@/local/clips";
import { createTwitchClip } from "@/platforms/twitch-clips";

/** Optional: also create a native Twitch clip for each clip of a Twitch stream. */
async function afterClip(clipId: number): Promise<void> {
  const settings = await getSettings();
  if (!settings.clips.twitchNativeClips) return;
  const clip = await db.get<LocalClip>("clips", clipId);
  if (!clip || clip.platform !== "twitch" || clip.detection_types?.includes("manual")) return;
  const streamer = await db.get<Streamer>("streamers", clip.streamer_id);
  if (!streamer || streamer.platform_user_id.startsWith("local:")) return;
  try {
    const t = await createTwitchClip(streamer.platform_user_id);
    await updateClip(clipId, { platform_clip_id: t.id, platform_clip_url: t.url, edit_url: t.editUrl });
  } catch (e) {
    await updateClip(clipId, { error_message: `Twitch clip not created: ${e instanceof Error ? e.message : "error"}` });
  }
}

const capture = createCaptureManager({ ...defaultCaptureDeps, afterClip });

/** Every stored highlight: clip it if that stream is being captured, then notify. */
async function onHighlight(h: LocalHighlight, s: Streamer): Promise<void> {
  const clipping = await capture.onHighlight(h, s);
  await notifyHighlight({ ...h, has_video: clipping }, s, await getSettings());
}

const chat = createChatManager({
  now: () => Date.now(),
  createSocket: (url) => new WebSocket(url),
  fetchImpl: (...a) => fetch(...a),
  onHighlight,
});
const manager = createMonitoringManager({
  afterCheck: async () => {
    await chat.sync();
    await capture.sync();
  },
  onHighlight,
});

function log(event: string, data?: Record<string, unknown>) {
  console.info(JSON.stringify({ src: "streamhunter.sw", event, ...data }));
}

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", { reason: details.reason });
  void (async () => {
    await manager.restore();
    await capture.reset();
    if (details.reason === "install") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("app.html#/overview") });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  log("browser_startup");
  void manager.restore();
  void capture.reset();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.heartbeat) void manager.tick();
});

/** Notification buttons: 0 = Open stream, 1 = Review. */
chrome.notifications?.onButtonClicked?.addListener((id, button) => {
  void chrome.notifications.clear(id);
  if (!id.startsWith(HIGHLIGHT_PREFIX)) return;
  void (async () => {
    const h = await db.get<LocalHighlight>("highlights", Number(id.slice(HIGHLIGHT_PREFIX.length)));
    const url = button === 0 && h?.streamer_username ? streamUrl({ platform: h.platform, username: h.streamer_username }) : chrome.runtime.getURL("app.html#/highlights");
    await chrome.tabs.create({ url });
  })();
});

chrome.notifications?.onClicked.addListener((id) => {
  const route = id.startsWith(HIGHLIGHT_PREFIX) ? "/highlights" : id.startsWith(NOTIFICATION_PREFIX) ? "/monitoring" : null;
  if (!route) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${route}`) });
  void chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  // Messages addressed to the offscreen document are not for the worker.
  if ((message as { target?: unknown } | null)?.target === "offscreen") return false;
  handleMessage(message, manager, capture).then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.tabs.onRemoved.addListener((tabId) => void capture.onTabRemoved(tabId));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const monitoring = changes[STORAGE_KEYS.monitoring];
  if (monitoring?.newValue) void renderBadge(monitoring.newValue as MonitoringState);

  if (changes[TWITCH_USER_KEY]) void chat.sync(); // signed in or out of Twitch

  const settings = changes[STORAGE_KEYS.settings];
  if (settings) {
    const next = sanitizeSettings(settings.newValue);
    void capture.applySettings(next);
    void getMonitoringState().then((s) => syncAlarms(s.enabled, next.monitoring.intervalMinutes));
  }
});

// The toolbar icon opens the popup; the side panel is opened explicitly from the popup.
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);

// Repaint the badge whenever the worker wakes up.
void getMonitoringState().then(renderBadge);
