import { db } from "@/local/db";
import { createHighlight, failInterruptedClips, type LocalHighlight } from "@/local/highlights";
import { enforceStorageLimits } from "@/local/clips";
import { activeSessionFor } from "@/local/sessions";
import { addStreamer, platformClients, resolveChannel, streamUrl } from "@/local/streamers";
import { getMonitoringState, getSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import type { Signal } from "@/detection/fusion";
import { listClips } from "@/local/clips";
import { nextRetry, plan, type SchedStreamer, type StreamerHistory } from "./scheduler";
import {
  CAPTURES_KEY, channelFromUrl, INITIAL_CAPTURE_STATE, STATS_KEY,
  type CaptureOptions, type CaptureState, type CaptureTarget, type ClipRequest, type PauseReason, type SlotHealth,
} from "@/types/capture";
import type { OffscreenRequest } from "@/types/messages";
import type { Settings } from "@/types/settings";

const OFFSCREEN_URL = "offscreen.html";
/** Default rolling buffer; Settings → Clips can change it. */
export const BUFFER_SECONDS = 120;

export const REARM_MESSAGE =
  "Video capture is inactive. Open a Twitch, Kick or YouTube tab, click the StreamHunter icon and choose Use this tab as a recorder.";

export interface CaptureDeps {
  now: () => number;
  /** chrome.tabCapture.getMediaStreamId; needs the editor to have invoked the extension on that tab. */
  streamIdFor: (tabId: number) => Promise<string>;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  toOffscreen: (message: OffscreenRequest) => Promise<{ ok: boolean; error?: string } | undefined>;
  notify: (title: string, message: string, id?: string) => Promise<void>;
  /** Point a recorder tab at a channel (chrome.tabs.update; no "tabs" permission needed). */
  navigate: (tabId: number, url: string) => Promise<void>;
  /** Called after a clip is saved (Twitch native clip, …). */
  afterClip?: (clipId: number, highlightId: number) => Promise<void>;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  return contexts.length > 0;
}

export const defaultCaptureDeps: CaptureDeps = {
  now: () => Date.now(),
  streamIdFor: (tabId) =>
    new Promise((resolve, reject) =>
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(err?.message ?? "no stream id"));
        else resolve(id);
      }),
    ),
  async ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
      justification: "Record the stream tabs the editor chose into local rolling buffers and cut clips from them (nothing is uploaded).",
    });
  },
  async closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  },
  toOffscreen: (message) => chrome.runtime.sendMessage(message),
  async notify(title, message, id) {
    await chrome.notifications
      ?.create(id ?? `sh-clip-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title, message, priority: 0 })
      .catch(() => undefined);
  },
  async navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },
};

// --- storage -----------------------------------------------------------------------------------

interface CapturesStore {
  slots: Record<string, CaptureState>;
  /** The last message once every slot has stopped ("The recorder tab was closed…"). */
  note: string | null;
  /** Clips saved since install (all slots). */
  clips: number;
}

async function readStore(): Promise<CapturesStore> {
  const raw = (await chrome.storage.local.get(CAPTURES_KEY))[CAPTURES_KEY] as Partial<CapturesStore> | undefined;
  const slots: Record<string, CaptureState> = {};
  for (const [k, v] of Object.entries(raw?.slots ?? {})) slots[k] = { ...INITIAL_CAPTURE_STATE, ...v };
  return { slots, note: raw?.note ?? null, clips: raw?.clips ?? 0 };
}

// Every engine reports every few seconds: serialise read-modify-write of the store.
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (s: CapturesStore) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const store = await readStore();
    const out = await fn(store);
    await chrome.storage.local.set({ [CAPTURES_KEY]: store });
    return out;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

const byArmed = (a: CaptureState, b: CaptureState) => (a.armedAt ?? "").localeCompare(b.armedAt ?? "");

/** All slots that are not off, oldest first. */
export async function getSlots(): Promise<CaptureState[]> {
  return Object.values((await readStore()).slots).filter((s) => s.status !== "off").sort(byArmed);
}

/**
 * One slot's state: the slot for `tabId`, else the first recording slot, else the first slot, else
 * an "off" state carrying the last note (what the single-stream UI shows).
 */
export async function getCaptureState(tabId?: number): Promise<CaptureState> {
  const store = await readStore();
  const slots = Object.values(store.slots).filter((s) => s.status !== "off").sort(byArmed);
  const found = tabId !== undefined ? store.slots[String(tabId)] : slots.find((s) => s.recording) ?? slots[0];
  return found && found.status !== "off" ? found : { ...INITIAL_CAPTURE_STATE, clips: store.clips, message: store.note };
}

export async function getStats(): Promise<{ recordedSeconds: number }> {
  const raw = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] as { recordedSeconds?: number } | undefined;
  return { recordedSeconds: raw?.recordedSeconds ?? 0 };
}

export function captureOptions(settings: Settings): CaptureOptions {
  return {
    quality: settings.recording.quality,
    bufferSeconds: settings.clips.bufferSeconds,
    preRollSeconds: settings.clips.preRollSeconds,
    postRollSeconds: settings.clips.postRollSeconds,
    maxClipSeconds: settings.clips.maxClipSeconds,
    weights: settings.detection.weights,
    clipThreshold: settings.detection.clipThreshold,
  };
}

// --- choosing streamers ------------------------------------------------------------------------

const eligible = (s: Streamer) => Boolean(s.auto_record) && s.monitoring_enabled && s.is_live === true;
/** Recording priority: favourites first, then most viewers. */
export const byPriority = (a: Streamer, b: Streamer) => Number(b.is_favorite) - Number(a.is_favorite) || (b.viewer_count ?? 0) - (a.viewer_count ?? 0);

/** Single-slot choice (kept for the one-recorder case): keep the current one while live. */
export function pickRecordingTarget(streamers: Streamer[], currentId: number | null): Streamer | null {
  return assignTargets(streamers, [{ slot: 0, current: currentId }])[0] ?? null;
}

/**
 * Which streamer each recorder slot records. Sticky: a slot keeps its streamer while that streamer
 * is live and eligible. Free slots then take the remaining live Auto-record streamers by priority.
 * A streamer is never recorded twice (`exclude`: streamers in manual captures).
 */
export function assignTargets(
  streamers: Streamer[],
  slots: { slot: number; current: number | null }[],
  exclude: Set<number> = new Set(),
): Record<number, Streamer | null> {
  const live = streamers.filter((s) => eligible(s) && !exclude.has(s.id)).sort(byPriority);
  const out: Record<number, Streamer | null> = {};
  const taken = new Set<number>();
  for (const sl of slots) {
    const keep = live.find((s) => s.id === sl.current && !taken.has(s.id));
    out[sl.slot] = keep ?? null;
    if (keep) taken.add(keep.id);
  }
  for (const sl of slots) {
    if (out[sl.slot]) continue;
    const next = live.find((s) => !taken.has(s.id)) ?? null;
    out[sl.slot] = next;
    if (next) taken.add(next.id);
  }
  return out;
}

/** The streamer record for a captured channel: from the monitoring list, else added to it. */
async function streamerFor(platform: Streamer["platform"], channel: string): Promise<Streamer> {
  const all = await db.all<Streamer>("streamers");
  const found = all.find((s) => s.platform === platform && s.username.toLowerCase() === channel);
  if (found) return found;
  try {
    return await addStreamer(await resolveChannel(platformClients(), platform, channel));
  } catch {
    // No platform credentials (or the API is down): keep a local record so clips have an owner.
    return db.put<Streamer>("streamers", {
      id: undefined as unknown as number, platform, platform_user_id: `local:${channel}`, username: channel, display_name: channel,
      profile_image_url: null, is_live: null, current_title: null, current_category: null, viewer_count: null, stream_started_at: null,
      status_checked_at: null, monitoring_enabled: false, is_favorite: false, updated_at: new Date().toISOString(),
    });
  }
}

async function targetFor(streamer: Streamer): Promise<CaptureTarget & { sessionKey: string }> {
  const session = await activeSessionFor(streamer.id);
  return {
    streamerId: streamer.id, sessionId: session?.id ?? null, platform: streamer.platform, displayName: streamer.display_name,
    username: streamer.username, broadcastStartedAt: session?.broadcast_started_at ?? streamer.stream_started_at,
    category: streamer.current_category, sessionKey: `${streamer.id}:${session?.id ?? streamer.stream_started_at ?? "?"}`,
  };
}

// --- scheduler inputs and outputs ----------------------------------------------------------------

export const SCHEDULER_KEY = "sh.scheduler";

/** What the dashboard shows about the scheduler (written after every run). */
export interface SchedulerSnapshot {
  at: string;
  maxSlots: number;
  armedSlots: number;
  recording: { slot: number; streamerId: number; name: string; platform: string; total: number | null; since: string | null }[];
  decisions: { slot: number; action: string; detail: string }[];
  queue: { streamerId: number; name: string; total: number | null; reason: string; detail: string }[];
  priorities: { streamerId: number; name: string; platform: string; username: string; platformUserId: string; total: number; parts: Record<string, number>; explain: string[] }[];
  tracked: number;
  live: number;
  lastRecordingAt: string | null;
  failures: { streamerId: number; name: string; error: string; failures: number; retryAt: string | null }[];
}

/** Local record per streamer: recording time, clips, recent moments (scheduler potential/activity). */
async function streamerHistory(now: number): Promise<Map<number, StreamerHistory>> {
  const [streamers, clips, highlights] = await Promise.all([db.all<SchedStreamer & { recorded_seconds?: number }>("streamers"), listClips(), db.all<LocalHighlight>("highlights")]);
  const since = new Date(now - 30 * 60_000).toISOString();
  const out = new Map<number, StreamerHistory>();
  for (const s of streamers) {
    const own = clips.filter((c) => c.streamer_id === s.id && c.status === "ready");
    out.set(s.id, {
      recordedSeconds: s.recorded_seconds ?? 0,
      clips: own.length,
      avgClipScore: own.length ? own.reduce((a, c) => a + c.score, 0) / own.length : null,
      recentMoments: highlights.filter((h) => h.streamer_id === s.id && h.timestamp >= since).length,
    });
  }
  return out;
}

/** A new broadcast gets a clean slate: failures of the previous one don't count. */
async function resetFailuresOnNewBroadcast(list: SchedStreamer[]): Promise<SchedStreamer[]> {
  const out: SchedStreamer[] = [];
  for (const s of list) {
    const x = s as SchedStreamer & { record_failure_broadcast?: string | null };
    if ((x.record_failures ?? 0) > 0 && x.record_failure_broadcast !== undefined && x.record_failure_broadcast !== s.stream_started_at && s.is_live) {
      const clean = { ...x, record_failures: 0, record_retry_at: null, record_error: null, record_failure_broadcast: null };
      await db.put("streamers", clean);
      out.push(clean);
    } else out.push(s);
  }
  return out;
}

async function saveSchedule(p: ReturnType<typeof plan>, streamers: SchedStreamer[], slots: CaptureState[], maxSlots: number, now: number) {
  const byId = new Map(streamers.map((s) => [s.id, s]));
  const total = new Map(p.priorities.map((x) => [x.streamerId, x.total]));
  const prev = (await chrome.storage.local.get(SCHEDULER_KEY))[SCHEDULER_KEY] as SchedulerSnapshot | undefined;
  const recordingNow = slots.filter((s) => s.recording && s.streamerId !== null);
  const snap: SchedulerSnapshot = {
    at: new Date(now).toISOString(),
    maxSlots,
    armedSlots: slots.filter((s) => s.mode === "recorder").length,
    recording: p.decisions
      .filter((d) => d.streamerId !== null)
      .map((d) => {
        const s = byId.get(d.streamerId!)!;
        return { slot: d.slot, streamerId: s.id, name: s.display_name, platform: s.platform, total: total.get(s.id) ?? null, since: slots.find((x) => x.tabId === d.slot)?.assignedAt ?? null };
      }),
    decisions: p.decisions.map((d) => ({ slot: d.slot, action: d.action, detail: d.detail })),
    queue: p.queue,
    priorities: p.priorities.map((x) => {
      const s = byId.get(x.streamerId);
      return { ...x, name: s?.display_name ?? "?", platform: s?.platform ?? "twitch", username: s?.username ?? "", platformUserId: s?.platform_user_id ?? "", parts: { ...x.parts } };
    }),
    tracked: streamers.filter((s) => s.monitoring_enabled).length,
    live: streamers.filter((s) => s.monitoring_enabled && s.is_live).length,
    lastRecordingAt: recordingNow.length ? new Date(now).toISOString() : (prev?.lastRecordingAt ?? null),
    failures: streamers
      .filter((s) => (s.record_failures ?? 0) > 0)
      .map((s) => ({ streamerId: s.id, name: s.display_name, error: s.record_error ?? "unknown", failures: s.record_failures ?? 0, retryAt: s.record_retry_at ?? null })),
  };
  await chrome.storage.local.set({ [SCHEDULER_KEY]: snap });
}

// --- manager ---------------------------------------------------------------------------------------

/** Recording slots, driven by the worker. State lives in storage (the worker may sleep in between). */
export function createCaptureManager(deps: CaptureDeps = defaultCaptureDeps) {
  const sessionKeys = new Map<number, string>(); // slot → broadcast being recorded (restart detection)
  const send = (m: OffscreenRequest) => deps.toOffscreen(m).catch(() => undefined);

  async function activeCount(): Promise<number> {
    return (await getSlots()).length;
  }

  async function checkLimit(tabId: number): Promise<void> {
    const settings = await getSettings();
    const slots = await getSlots();
    if (slots.some((s) => s.tabId === tabId)) return; // replacing this tab's own slot
    if (slots.length >= settings.recording.maxStreams)
      throw new Error(
        settings.recording.maxStreams === 1
          ? "Already recording one stream. Stop it first, or allow more simultaneous streams in Settings → Recording."
          : `Already recording ${slots.length} streams (the limit). Stop one, or raise the limit in Settings → Recording.`,
      );
    // Only a recent, sustained overload measured while streams were running blocks a new one.
    const system = (await chrome.storage.local.get("sh.system"))["sh.system"] as { overloaded?: boolean; reason?: string; at?: string } | undefined;
    const fresh = system?.at ? deps.now() - Date.parse(system.at) < 30_000 : false;
    if (system?.overloaded && fresh && slots.length > 0) throw new Error(`Not starting another stream: ${system.reason ?? "the Mac is overloaded"}.`);
  }

  /** Whether this new slot should play its sound (Settings → Recording → sound). */
  async function shouldListen(): Promise<boolean> {
    const settings = await getSettings();
    if (settings.recording.audio === "none") return false;
    return !(await getSlots()).some((s) => s.listening);
  }

  async function launch(tabId: number, target: CaptureTarget | null, listen: boolean): Promise<void> {
    let streamId: string;
    try {
      streamId = await deps.streamIdFor(tabId);
    } catch (e) {
      throw new Error(`Chrome didn't allow capturing this tab: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    const settings = await getSettings();
    await deps.ensureOffscreen();
    const res = await deps.toOffscreen({
      target: "offscreen", type: "capture/start", slot: tabId, streamId, capture: target, options: { ...captureOptions(settings), listen },
    });
    if (!res?.ok) {
      await removeSlot(tabId, res?.error ?? "The capture did not start");
      throw new Error(res?.error ?? "The capture did not start");
    }
  }

  async function putSlot(tabId: number, s: CaptureState): Promise<CaptureState> {
    return mutate((store) => {
      store.slots[String(tabId)] = s;
      return s;
    });
  }

  async function patchSlot(tabId: number, p: Partial<CaptureState>): Promise<CaptureState> {
    return mutate((store) => {
      const cur = store.slots[String(tabId)];
      if (!cur || cur.status === "off") return cur ?? { ...INITIAL_CAPTURE_STATE };
      const next = { ...cur, ...p };
      store.slots[String(tabId)] = next;
      return next;
    });
  }

  async function removeSlot(tabId: number, note: string | null): Promise<void> {
    await mutate((store) => {
      delete store.slots[String(tabId)];
      if (note !== null || Object.keys(store.slots).length === 0) store.note = note;
    });
    sessionKeys.delete(tabId);
  }

  /** Manual capture: the stream open in this tab, chosen from the popup. */
  async function start(tabId: number, url: string): Promise<CaptureState> {
    const channel = channelFromUrl(url);
    if (!channel) throw new Error("Open a Twitch, Kick or YouTube channel in this tab first");
    await checkLimit(tabId);
    if ((await getCaptureState(tabId)).status !== "off") await stop(tabId);
    const streamer = await streamerFor(channel.platform, channel.channel);
    if ((await getSlots()).some((s) => s.streamerId === streamer.id)) throw new Error(`${streamer.display_name} is already being recorded in another tab.`);
    const { sessionKey: _key, ...target } = await targetFor(streamer);
    const listen = await shouldListen();
    const at = new Date(deps.now()).toISOString();
    await putSlot(tabId, { ...INITIAL_CAPTURE_STATE, status: "starting", tabId, platform: channel.platform, channel: channel.channel, streamerId: streamer.id, armedAt: at, listening: listen });
    await launch(tabId, target, listen);
    const settings = await getSettings();
    return patchSlot(tabId, {
      status: "capturing",
      recording: true,
      startedAt: at,
      message: `Buffering the last ${Math.round(settings.clips.bufferSeconds / 60)} minutes. Detected moments become clips.`,
    });
  }

  /**
   * Recorder mode: this tab becomes one of StreamHunter's recorders. The editor's click (the popup)
   * is the only one needed per tab; from then on the tab is navigated to a live Auto-record streamer.
   */
  async function arm(tabId: number): Promise<CaptureState> {
    await checkLimit(tabId);
    if ((await getCaptureState(tabId)).status !== "off") await stop(tabId);
    const listen = await shouldListen();
    const at = new Date(deps.now()).toISOString();
    await putSlot(tabId, { ...INITIAL_CAPTURE_STATE, status: "starting", mode: "recorder", tabId, armedAt: at, listening: listen });
    await launch(tabId, null, listen);
    await patchSlot(tabId, { status: "capturing", recording: false, startedAt: at, waitingReason: "Checking who is live…", message: null });
    await sync();
    return getCaptureState(tabId);
  }

  let syncing: Promise<CaptureState> | null = null;
  /** Match the recorder tabs to the live Auto-record streamers (after every status check). */
  function sync(): Promise<CaptureState> {
    syncing ??= runSync().finally(() => (syncing = null));
    return syncing;
  }

  async function runSync(): Promise<CaptureState> {
    const [settings, monitoring] = await Promise.all([getSettings(), getMonitoringState()]);
    let slots = await getSlots();
    // The limit was lowered: stop the newest slots beyond it.
    for (const extra of slots.slice(settings.recording.maxStreams)) {
      if (extra.tabId !== null) await stop(extra.tabId, `Stopped: the limit is now ${settings.recording.maxStreams} simultaneous stream${settings.recording.maxStreams === 1 ? "" : "s"}.`);
    }
    slots = await getSlots();
    const recorders = slots.filter((s) => s.mode === "recorder" && s.status === "capturing" && s.tabId !== null);
    if (recorders.length === 0) return getCaptureState();

    if (!monitoring.enabled || monitoring.paused) {
      for (const r of recorders) {
        if (!monitoring.enabled) {
          await send({ target: "offscreen", type: "capture/target", slot: r.tabId!, capture: null });
          sessionKeys.delete(r.tabId!);
          await patchSlot(r.tabId!, { recording: false, streamerId: null, channel: null, waitingReason: "Monitoring is stopped. Start monitoring to record automatically." });
        } else if (!r.paused) {
          await send({ target: "offscreen", type: "capture/pause", slot: r.tabId!, paused: true });
          await patchSlot(r.tabId!, { recording: false, paused: true, pauseReason: "monitoring", waitingReason: "Monitoring is paused." });
        }
      }
      return getCaptureState();
    }

    const streamers = await resetFailuresOnNewBroadcast(await db.all<SchedStreamer>("streamers"));
    const manualIds = new Set(slots.filter((s) => s.mode === "manual" && s.streamerId !== null).map((s) => s.streamerId!));
    const nowMs = deps.now();
    const schedule = plan(
      streamers,
      await streamerHistory(nowMs),
      recorders.map((r) => ({ slot: r.tabId!, streamerId: r.streamerId, assignedAt: r.assignedAt, pendingClips: r.health?.pendingClips ?? 0, paused: r.paused && r.pauseReason !== "monitoring" })),
      { maxSlots: settings.recording.maxStreams, ...settings.scheduler },
      nowMs,
      manualIds,
      new Map(recorders.filter((r) => r.switchedAt).map((r) => [r.tabId!, r.switchedAt!])),
    );
    await saveSchedule(schedule, streamers, slots, settings.recording.maxStreams, nowMs);
    const anyAuto = streamers.some((x) => x.auto_record && x.monitoring_enabled);
    const byId = new Map(streamers.map((x) => [x.id, x]));

    for (const r of recorders) {
      const tabId = r.tabId!;
      const decision = schedule.decisions.find((d) => d.slot === tabId);
      const next = decision?.streamerId != null ? (byId.get(decision.streamerId) ?? null) : null;
      // Resume slots paused only because monitoring was paused.
      const pausedNow = r.paused && r.pauseReason !== "monitoring";
      if (r.paused && r.pauseReason === "monitoring") await send({ target: "offscreen", type: "capture/pause", slot: tabId, paused: false });
      if (!next) {
        if (r.streamerId !== null || r.recording) await send({ target: "offscreen", type: "capture/target", slot: tabId, capture: null });
        sessionKeys.delete(tabId);
        await patchSlot(tabId, {
          recording: false, paused: pausedNow, pauseReason: pausedNow ? r.pauseReason : null, streamerId: null, channel: null, assignedAt: null,
          message: decision?.action === "release" ? decision.detail : r.message,
          waitingReason: anyAuto
            ? recorders.length > 1 ? "Waiting for another Auto-record streamer to go live." : "Waiting for an Auto-record streamer to go live."
            : "No streamer has Auto-record on. Turn it on in My Streamers.",
        });
        continue;
      }
      const { sessionKey, ...target } = await targetFor(next);
      const switching = next.id !== r.streamerId;
      const last = sessionKeys.get(tabId);
      const restarted = !switching && last !== undefined && sessionKey !== last;
      if (switching || restarted) await deps.navigate(tabId, streamUrl(next)).catch(() => undefined);
      sessionKeys.set(tabId, sessionKey);
      await send({ target: "offscreen", type: "capture/target", slot: tabId, capture: target });
      const at = new Date(nowMs).toISOString();
      await patchSlot(tabId, {
        recording: !pausedNow, paused: pausedNow, pauseReason: pausedNow ? r.pauseReason : null,
        streamerId: next.id, platform: next.platform, channel: next.username.toLowerCase(), waitingReason: null,
        assignedAt: switching ? at : (r.assignedAt ?? at),
        switchedAt: switching && r.streamerId !== null ? at : r.switchedAt,
        message: switching ? (decision?.action === "switch" && r.streamerId !== null ? decision.detail : `Recording ${next.display_name}.`) : restarted ? `${next.display_name} restarted the stream; recording again.` : r.message,
      });
    }
    return getCaptureState();
  }

  /** Stop one slot (tabId) or all of them. */
  async function stop(tabId?: number, message: string | null = null): Promise<CaptureState> {
    const slots = tabId === undefined ? await getSlots() : [await getCaptureState(tabId)].filter((s) => s.status !== "off");
    await send({ target: "offscreen", type: "capture/stop", ...(tabId === undefined ? {} : { slot: tabId }) });
    for (const s of slots) if (s.tabId !== null) await removeSlot(s.tabId, message);
    if (tabId === undefined) await mutate((store) => void (store.note = message));
    if ((await activeCount()) === 0) {
      await deps.closeOffscreen().catch(() => undefined);
      // Nothing records any more: an old overload verdict no longer applies.
      const sys = (await chrome.storage.local.get("sh.system"))["sh.system"] as Record<string, unknown> | undefined;
      if (sys?.overloaded) await chrome.storage.local.set({ "sh.system": { ...sys, overloaded: false, reason: null } });
    }
    // Hand the speakers to another slot when the listened one stops.
    if (slots.some((s) => s.listening) && (await getSettings()).recording.audio === "first") {
      const next = (await getSlots())[0];
      if (next?.tabId != null) await setListening(next.tabId, true);
    }
    return getCaptureState();
  }

  /** Pause/resume one slot, or (no tabId) all of them, e.g. Pause monitoring. */
  async function setPaused(paused: boolean, tabId?: number, reason: PauseReason = tabId === undefined ? "monitoring" : "you"): Promise<CaptureState> {
    const slots = tabId === undefined ? await getSlots() : [await getCaptureState(tabId)];
    for (const s of slots) {
      if (s.status !== "capturing" || s.tabId === null) continue;
      // A global pause/resume never touches slots paused for another reason (the editor's own pause, overload…).
      if (tabId === undefined && paused && s.paused) continue;
      if (tabId === undefined && !paused && s.paused && s.pauseReason !== reason) continue;
      await send({ target: "offscreen", type: "capture/pause", slot: s.tabId, paused });
      await patchSlot(s.tabId, {
        paused, pauseReason: paused ? reason : null,
        recording: !paused && (s.mode === "manual" || s.streamerId !== null),
      });
    }
    if (!paused && slots.some((s) => s.mode === "recorder")) await sync();
    return getCaptureState(tabId);
  }

  /** Only one slot plays its sound at a time. */
  async function setListening(tabId: number, on: boolean): Promise<CaptureState> {
    for (const s of await getSlots()) {
      if (s.tabId === null) continue;
      const want = s.tabId === tabId ? on : on ? false : s.listening;
      if (want !== s.listening) {
        await send({ target: "offscreen", type: "capture/listen", slot: s.tabId, on: want });
        await patchSlot(s.tabId, { listening: want });
      }
    }
    return getCaptureState(tabId);
  }

  /** Overload protection: record a slot at half frame rate. */
  async function setThrottled(tabId: number, on: boolean): Promise<void> {
    await send({ target: "offscreen", type: "capture/throttle", slot: tabId, on });
    const s = await getCaptureState(tabId);
    if (s.health) await patchSlot(tabId, { health: { ...s.health, throttled: on } });
  }

  async function applySettings(settings: Settings): Promise<void> {
    for (const s of await getSlots())
      if (s.status === "capturing" && s.tabId !== null)
        await send({ target: "offscreen", type: "capture/options", slot: s.tabId, options: { ...captureOptions(settings), listen: s.listening } });
    await sync();
  }

  /** "Save the last N seconds" from the popup (that tab's slot, else the first recording one). */
  async function saveLast(seconds: number, tabId?: number): Promise<CaptureState> {
    const s = await getCaptureState(tabId);
    if (s.status !== "capturing" || s.streamerId === null || !s.recording || s.tabId === null) throw new Error("Nothing is being recorded right now");
    const streamer = await db.get<Streamer>("streamers", s.streamerId);
    if (!streamer) throw new Error("The captured streamer is no longer on the list");
    const now = deps.now();
    const session = await activeSessionFor(streamer.id);
    const h = await createHighlight({
      streamer, session: session ?? null, origin: "capture", peakAt: now, startAt: now - seconds * 1000, endAt: now,
      score: 70, confidence: 1, category: "other", reasons: ["Saved by you"],
      breakdown: { chat: null, audio: null, visual: null, context: null, active_signals: [], manual: true },
      clipStatus: "generating",
    });
    const request: ClipRequest = { highlightId: h.id, start: h.window_start_ms, end: h.window_end_ms, title: `${streamer.display_name} · Saved by you`, score: h.score };
    await send({ target: "offscreen", type: "capture/clip", slot: s.tabId, request });
    return patchSlot(s.tabId, { message: `Saving the last ${seconds} s…` });
  }

  /**
   * A highlight found elsewhere (chat, viewers). If that streamer is being recorded in some slot, it
   * becomes a fusion signal for that slot's engine; alone it stays a provisional highlight.
   */
  async function onHighlight(h: LocalHighlight, s: Streamer): Promise<boolean> {
    const slot = (await getSlots()).find((x) => x.status === "capturing" && x.recording && x.streamerId === s.id && h.origin !== "capture");
    if (!slot || slot.tabId === null) return false;
    const settings = await getSettings();
    const b = h.signal_breakdown ?? {};
    const signal: Signal = {
      kind: h.origin === "viewers" ? "viewers" : "chat",
      at: Date.parse(h.timestamp),
      start: h.window_start_ms + settings.clips.preRollSeconds * 1000,
      end: Math.max(h.window_start_ms + settings.clips.preRollSeconds * 1000, h.window_end_ms - settings.clips.postRollSeconds * 1000),
      intensity: (h.origin === "viewers" ? b.context : b.chat) ?? h.score,
      reasons: h.reasons,
      highlightIds: [h.id],
    };
    if (h.origin === "viewers") signal.start = signal.end = signal.at; // a status check only knows "now"
    await send({ target: "offscreen", type: "capture/signal", slot: slot.tabId, signal });
    return true;
  }

  async function onStatus(tabId: number, st: { bufferedSeconds: number; levelDb: number | null; recordedSeconds?: number; silentSeconds?: number; health?: SlotHealth }) {
    const s = await getCaptureState(tabId);
    if (s.status !== "capturing" || s.tabId !== tabId) return;
    const recorded = st.recordedSeconds ?? s.recordedSeconds;
    const delta = Math.max(0, recorded - s.recordedSeconds);
    if (delta > 0) {
      const stats = await getStats();
      await chrome.storage.local.set({ [STATS_KEY]: { recordedSeconds: stats.recordedSeconds + delta } });
    }
    await patchSlot(tabId, {
      bufferedSeconds: st.bufferedSeconds, levelDb: st.levelDb, recordedSeconds: recorded, silentSeconds: st.silentSeconds ?? 0,
      ...(st.health ? { health: st.health } : {}),
    });
    if (s.streamerId === null || !s.recording) return;
    const streamer = await db.get<SchedStreamer & { recorded_seconds?: number; record_failure_broadcast?: string | null }>("streamers", s.streamerId);
    if (!streamer) return;
    // Per-streamer recording time (scheduler: clips per recorded hour).
    let next = { ...streamer, recorded_seconds: (streamer.recorded_seconds ?? 0) + delta };
    // A healthy recording of 10 minutes clears earlier failures.
    const healthyFor = s.assignedAt ? (deps.now() - Date.parse(s.assignedAt)) / 1000 : 0;
    if ((next.record_failures ?? 0) > 0 && healthyFor >= 600 && !(st.health?.noVideoSeconds || st.health?.blackSeconds))
      next = { ...next, record_failures: 0, record_retry_at: null, record_error: null };
    await db.put("streamers", next);
    // The player isn't showing the stream: a failed recording of this streamer (the slot moves on).
    const h = st.health;
    const reason = h && (h.noVideoSeconds ?? 0) >= 45 ? "the player shows no picture (frozen, paused or blocked)" : h && (h.blackSeconds ?? 0) >= 60 ? "the player shows a black screen" : null;
    if (reason) await recordingFailed(tabId, s.streamerId, reason);
  }

  /** A recording of `streamerId` in slot `tabId` failed: release the slot, retry later (2, 5, 15 min). */
  async function recordingFailed(tabId: number, streamerId: number, reason: string): Promise<void> {
    const settings = await getSettings();
    const streamer = await db.get<SchedStreamer & { record_failure_broadcast?: string | null }>("streamers", streamerId);
    if (!streamer) return;
    const failures = (streamer.record_failures ?? 0) + 1;
    const retryAt = nextRetry(failures, deps.now(), settings.scheduler.maxRetries);
    await db.put("streamers", {
      ...streamer, record_failures: failures, record_retry_at: retryAt, record_error: reason, record_failure_broadcast: streamer.stream_started_at,
    });
    await send({ target: "offscreen", type: "capture/target", slot: tabId, capture: null });
    sessionKeys.delete(tabId);
    await patchSlot(tabId, {
      recording: false, streamerId: null, channel: null, assignedAt: null,
      message: `Couldn't record ${streamer.display_name}: ${reason}. ${retryAt ? `Retrying at ${new Date(retryAt).toLocaleTimeString()}.` : "Not retried until the next broadcast."}`,
    });
    await deps.notify("Recording problem", `${streamer.display_name}: ${reason}.`, `sh-fail-${streamerId}-${failures}`);
    await sync();
  }

  async function onDetection(tabId: number, d: { at: number; reasons: string[]; score: number; clipped: boolean }) {
    await patchSlot(tabId, { lastDetection: { at: new Date(d.at).toISOString(), reasons: d.reasons, score: d.score, clipped: d.clipped } });
  }

  async function onClipSaved(tabId: number, clipId: number, highlightId: number, durationSec: number) {
    const s = await getCaptureState(tabId);
    await mutate((store) => void (store.clips += 1));
    await patchSlot(tabId, { clips: s.clips + 1, lastClipAt: new Date(deps.now()).toISOString(), message: `Clip saved (${Math.round(durationSec)} s).` });
    const h = await db.get<LocalHighlight>("highlights", highlightId);
    await deps.notify("Clip saved", `${h?.streamer_display_name ?? "Stream"}: ${h?.reasons[0] ?? "highlight"} (${Math.round(durationSec)} s)`, `sh-clip-${clipId}`);
    const settings = await getSettings();
    await enforceStorageLimits(settings.storage, new Date(deps.now())).catch(() => undefined);
    await deps.afterClip?.(clipId, highlightId).catch(() => undefined);
  }

  async function onClipFailed(tabId: number, reason: string) {
    await patchSlot(tabId, { message: reason });
  }

  async function onEnded(tabId: number, reason: string) {
    const s = await getCaptureState(tabId);
    if (s.status === "off" || s.tabId !== tabId) return;
    if (s.mode === "recorder") {
      // Try to resume on the same tab (Chrome may still allow it); otherwise say what to do.
      try {
        await launch(tabId, null, s.listening);
        sessionKeys.delete(tabId);
        await patchSlot(tabId, { status: "capturing", streamerId: null, channel: null, recording: false, message: `Capture restarted (${reason}).` });
        await sync();
        return;
      } catch {
        await stop(tabId, `${reason} ${REARM_MESSAGE}`);
        return;
      }
    }
    await stop(tabId, reason);
  }

  async function onTabRemoved(tabId: number) {
    const s = await getCaptureState(tabId);
    if (s.status !== "off" && s.tabId === tabId) await stop(tabId, s.mode === "recorder" ? `A recorder tab was closed. ${REARM_MESSAGE}` : "The captured tab was closed.");
  }

  /** After a browser restart every capture is gone; never show a stale "capturing". */
  async function reset() {
    await failInterruptedClips().catch(() => undefined);
    const slots = await getSlots();
    if (slots.length === 0) return;
    const recorder = slots.some((s) => s.mode === "recorder");
    await mutate((store) => {
      store.slots = {};
      store.note = recorder ? `Chrome restarted. ${REARM_MESSAGE}` : null;
    });
    sessionKeys.clear();
  }

  return {
    start, arm, sync, stop, setPaused, setListening, setThrottled, applySettings, saveLast, recordingFailed,
    onHighlight, onStatus, onDetection, onClipSaved, onClipFailed, onEnded, onTabRemoved, reset,
  };
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;
