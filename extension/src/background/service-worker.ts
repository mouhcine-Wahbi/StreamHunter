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
import { byPriority, createCaptureManager, defaultCaptureDeps, getSlots } from "./capture-manager";
import { createGovernor, defaultGovernorIo } from "./resource-governor";
import { enforceStorageLimits } from "@/local/clips";
import { SYSTEM_KEY } from "@/types/capture";
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

/** Overload protection across all recording slots (see resource-governor.ts). */
const governor = createGovernor({
  now: () => Date.now(),
  ...defaultGovernorIo,
  async slots() {
    const [slots, streamers] = await Promise.all([getSlots(), db.all<Streamer>("streamers")]);
    const rank = (id: number | null) => streamers.find((s) => s.id === id);
    // Highest priority first: favourites, then most viewers; manual captures count as top priority.
    return slots.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "manual" ? -1 : 1;
      const sa = rank(a.streamerId);
      const sb = rank(b.streamerId);
      return sa && sb ? byPriority(sa, sb) : sa ? -1 : sb ? 1 : 0;
    });
  },
  enabled: async () => (await getSettings()).recording.protectResources,
  async apply(a) {
    if (a.kind === "throttle") await capture.setThrottled(a.tabId, a.on);
    else if (a.kind === "pause") await capture.setPaused(a.paused, a.tabId, a.reason);
    else await enforceStorageLimits((await getSettings()).storage, new Date());
  },
  async notify(message) {
    await chrome.notifications
      ?.create(`sh-load-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: "StreamHunter", message, priority: 0 })
      .catch(() => undefined);
  },
  save: (load) => chrome.storage.local.set({ [SYSTEM_KEY]: load }),
});

/** Keyboard shortcut (Alt+Shift+R by default): arm the current Twitch/Kick/YouTube tab as a recorder. */
chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command !== "arm-recorder" || tab?.id === undefined) return;
  const id = tab.id;
  void (async () => {
    const host = (() => {
      try {
        return new URL(tab.url ?? "").hostname;
      } catch {
        return "";
      }
    })();
    const message = /(^|\.)(twitch\.tv|kick\.com|youtube\.com)$/.test(host)
      ? await capture.arm(id).then(
          () => "This tab is now a recorder.",
          (e: unknown) => (e instanceof Error ? e.message : "Could not use this tab as a recorder."),
        )
      : "Open twitch.tv, kick.com or youtube.com in this tab first.";
    await chrome.notifications
      ?.create(`sh-arm-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: "StreamHunter", message, priority: 0 })
      .catch(() => undefined);
  })();
});

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
    // Show the workspace first; the clean-up after an install/update runs behind it.
    if (details.reason === "install") await chrome.tabs.create({ url: chrome.runtime.getURL("app.html#/overview") });
    await capture.reset(); // local and quick: interrupted clips are marked failed before anything else
    await manager.restore();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  log("browser_startup");
  void capture.reset().then(() => manager.restore());
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
  handleMessage(message, manager, capture, () => governor.maybeRun()).then(sendResponse);
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
