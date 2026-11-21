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
import { ALARMS, syncAlarms, syncDiscoveryAlarm, syncPublishingAlarm } from "./alarm-manager";
import { runDiscovery } from "@/discovery/runner";
import { renderBadge } from "./badge";
import { handleMessage, isTrustedSender } from "./message-handler";
import { createMonitoringManager } from "./monitoring-manager";
import { APPROVAL_PREFIX, HIGHLIGHT_PREFIX, NOTIFICATION_PREFIX, notifyHighlight, notifyPublishing } from "./notifications";
import { createApprovalManager } from "./approval-manager";
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
import type { Approval, ApprovalAction } from "@/local/approvals";
import { createProcessingManager } from "./processing-manager";
import { createContentManager } from "./content-manager";
import { planAuto } from "@/publishing/plan";
import { runPublishing } from "@/publishing/runner";
import { hasPendingWork } from "@/processing/pending";

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
const approvals = createApprovalManager();

// 3.0 metadata and viral-potential score, written when a clip's formats are ready.
const content = createContentManager({
  ensureOffscreen: defaultCaptureDeps.ensureOffscreen,
  toOffscreen: (m) => chrome.runtime.sendMessage(m),
  // 3.0 publishing: automatic jobs for high/medium potential, then run them.
  afterContent: async (clipId) => {
    await planAuto(clipId, await getSettings());
    void publish();
  },
});

/** Runs due publishing jobs; notifications only for confirmed posts and final failures. */
const publish = () =>
  runPublishing({
    onPublished: (j) => void clipTitle(j.clip_id).then((t) => notifyPublishing(j, t)),
    onFailed: (j) => void clipTitle(j.clip_id).then((t) => notifyPublishing(j, t)),
  }).catch((e) => {
    log("publishing_failed", { error: e instanceof Error ? e.message : "?" });
    return { processed: 0 };
  });
const clipTitle = async (id: number) => (await db.get<{ title: string | null }>("clips", id))?.title ?? "Clip";

// 3.0 processing: formats are made in the offscreen document; it stays open until the queue is done.
const processing = createProcessingManager({
  onAssetReady: async (_assetId, clipId) => void (await content.prepare(clipId, await getSettings()).catch((e) => log("content_failed", { clipId, error: e instanceof Error ? e.message : "?" }))),
  ensureOffscreen: defaultCaptureDeps.ensureOffscreen,
  kick: () => chrome.runtime.sendMessage({ target: "offscreen", type: "process/kick" }),
  async closeIfIdle() {
    if ((await getSlots()).some((s) => s.status !== "off")) return;
    if (await hasPendingWork()) return void processing.kick().catch(() => undefined);
    await defaultCaptureDeps.closeOffscreen().catch(() => undefined);
  },
});
/** Work left by a closed browser or document continues on start and every 5 minutes. */
const resumeProcessing = () => void hasPendingWork().then((p) => (p ? processing.kick() : null)).catch(() => undefined);
resumeProcessing();
void syncPublishingAlarm().catch(() => undefined);

const manager = createMonitoringManager({
  approvals,
  afterCheck: async () => {
    await chat.sync();
    await capture.sync();
  },
  onHighlight,
});

/** Apply a recording decision, then let the scheduler act on it right away. */
async function decideApproval(id: string, action: ApprovalAction): Promise<Approval> {
  const a = await approvals.apply(id, action, await getSettings());
  await capture.sync().catch(() => undefined);
  if (action === "approve" && (await getSlots()).filter((s) => s.mode === "recorder").length === 0) {
    await chrome.notifications
      ?.create(`sh-noslot-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: `${a.streamerName}: approved`,
        message: "No recorder tab is armed yet. Open Live Monitoring → Open recorder tabs, then press Alt+Shift+R in each.",
        priority: 1,
      })
      .catch(() => undefined);
  }
  return a;
}

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
  if (alarm.name === ALARMS.publishing) {
    resumeProcessing();
    void publish();
  }
  if (alarm.name === ALARMS.discovery) void getSettings().then((s) => (s.discovery.enabled ? runDiscovery(s) : null)).catch((e) => log("discovery_failed", { error: e instanceof Error ? e.message : "?" }));
});

/** Notification buttons. Recording request: 0 = Record, 1 = Decline. Highlight: 0 = Open stream, 1 = Review. */
chrome.notifications?.onButtonClicked?.addListener((id, button) => {
  void chrome.notifications.clear(id);
  if (id.startsWith(APPROVAL_PREFIX)) {
    void decideApproval(id.slice(APPROVAL_PREFIX.length), button === 0 ? "approve" : "decline");
    return;
  }
  if (!id.startsWith(HIGHLIGHT_PREFIX)) return;
  void (async () => {
    const h = await db.get<LocalHighlight>("highlights", Number(id.slice(HIGHLIGHT_PREFIX.length)));
    const url = button === 0 && h?.streamer_username ? streamUrl({ platform: h.platform, username: h.streamer_username }) : chrome.runtime.getURL("app.html#/highlights");
    await chrome.tabs.create({ url });
  })();
});

chrome.notifications?.onClicked.addListener((id) => {
  const route = id.startsWith(HIGHLIGHT_PREFIX) ? "/highlights" : id.startsWith(NOTIFICATION_PREFIX) || id.startsWith(APPROVAL_PREFIX) ? "/monitoring" : null;
  if (!route) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${route}`) });
  void chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  // Messages addressed to the offscreen document are not for the worker.
  if ((message as { target?: unknown } | null)?.target === "offscreen") return false;
  handleMessage(message, manager, capture, () => governor.maybeRun(), decideApproval, processing, content, publish).then(sendResponse);
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
    void syncDiscoveryAlarm(next.discovery.enabled, next.discovery.intervalHours);
  }
});

// The toolbar icon opens the popup; the side panel is opened explicitly from the popup.
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);

// 3.0 schedules (idempotent on every worker start).
void getSettings().then((s) => syncDiscoveryAlarm(s.discovery.enabled, s.discovery.intervalHours)).catch(() => undefined);

// Repaint the badge whenever the worker wakes up.
void getMonitoringState().then(renderBadge);
