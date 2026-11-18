import { db } from "@/local/db";
import { createHighlight, type LocalHighlight } from "@/local/highlights";
import { enforceStorageLimits } from "@/local/clips";
import { activeSessionFor } from "@/local/sessions";
import { addStreamer, platformClients, resolveChannel, streamUrl } from "@/local/streamers";
import { getMonitoringState, getSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import type { Signal } from "@/detection/fusion";
import {
  CAPTURE_KEY, channelFromUrl, INITIAL_CAPTURE_STATE, STATS_KEY,
  type CaptureOptions, type CaptureState, type CaptureTarget, type ClipRequest,
} from "@/types/capture";
import type { OffscreenRequest } from "@/types/messages";
import type { Settings } from "@/types/settings";

const OFFSCREEN_URL = "offscreen.html";
/** Default rolling buffer; Settings → Clips can change it. */
export const BUFFER_SECONDS = 120;

export const REARM_MESSAGE =
  "Video capture is inactive. Open a Twitch or Kick tab, click the StreamHunter icon and choose Use this tab as the recorder.";

export interface CaptureDeps {
  now: () => number;
  /** chrome.tabCapture.getMediaStreamId; needs the editor to have invoked the extension on that tab. */
  streamIdFor: (tabId: number) => Promise<string>;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  toOffscreen: (message: OffscreenRequest) => Promise<{ ok: boolean; error?: string } | undefined>;
  notify: (title: string, message: string, id?: string) => Promise<void>;
  /** Point the recorder tab at a channel (chrome.tabs.update; no "tabs" permission needed). */
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
      justification: "Record the stream tab the editor chose into a local rolling buffer and cut clips from it (nothing is uploaded).",
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

export async function getCaptureState(): Promise<CaptureState> {
  const raw = (await chrome.storage.local.get(CAPTURE_KEY))[CAPTURE_KEY];
  return { ...INITIAL_CAPTURE_STATE, ...((raw ?? {}) as Partial<CaptureState>) };
}

async function setCaptureState(s: CaptureState): Promise<CaptureState> {
  await chrome.storage.local.set({ [CAPTURE_KEY]: s });
  return s;
}

const patch = async (p: Partial<CaptureState>) => setCaptureState({ ...(await getCaptureState()), ...p });

export async function getStats(): Promise<{ recordedSeconds: number }> {
  const raw = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY] as { recordedSeconds?: number } | undefined;
  return { recordedSeconds: raw?.recordedSeconds ?? 0 };
}

export function captureOptions(settings: Settings): CaptureOptions {
  return {
    bufferSeconds: settings.clips.bufferSeconds,
    preRollSeconds: settings.clips.preRollSeconds,
    postRollSeconds: settings.clips.postRollSeconds,
    maxClipSeconds: settings.clips.maxClipSeconds,
    weights: settings.detection.weights,
    clipThreshold: settings.detection.clipThreshold,
  };
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

/**
 * Which streamer the recorder should show: keep the current one while it is live (no flapping);
 * otherwise the live "Auto-record" streamer with the most viewers, favourites first.
 */
export function pickRecordingTarget(streamers: Streamer[], currentId: number | null): Streamer | null {
  const live = streamers.filter((s) => s.auto_record && s.monitoring_enabled && s.is_live === true);
  const current = live.find((s) => s.id === currentId);
  if (current) return current;
  return (
    [...live].sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || (b.viewer_count ?? 0) - (a.viewer_count ?? 0))[0] ?? null
  );
}

/** Capture, driven by the worker. State lives in storage (the worker may sleep in between). */
export function createCaptureManager(deps: CaptureDeps = defaultCaptureDeps) {
  async function launch(tabId: number, target: CaptureTarget | null): Promise<void> {
    let streamId: string;
    try {
      streamId = await deps.streamIdFor(tabId);
    } catch (e) {
      throw new Error(`Chrome didn't allow capturing this tab: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    const settings = await getSettings();
    await deps.ensureOffscreen();
    const res = await deps.toOffscreen({ target: "offscreen", type: "capture/start", streamId, capture: target, options: captureOptions(settings) });
    if (!res?.ok) {
      await deps.closeOffscreen();
      await setCaptureState({ ...INITIAL_CAPTURE_STATE, status: "error", message: res?.error ?? "The capture did not start" });
      throw new Error(res?.error ?? "The capture did not start");
    }
  }

  /** Manual capture: the stream open in this tab, chosen from the popup. */
  async function start(tabId: number, url: string): Promise<CaptureState> {
    const channel = channelFromUrl(url);
    if (!channel) throw new Error("Open a Twitch or Kick channel in this tab first");
    if ((await getCaptureState()).status !== "off") await stop();
    const streamer = await streamerFor(channel.platform, channel.channel);
    const { sessionKey: _key, ...target } = await targetFor(streamer);
    await setCaptureState({ ...INITIAL_CAPTURE_STATE, status: "starting", tabId, platform: channel.platform, channel: channel.channel, streamerId: streamer.id });
    await launch(tabId, target);
    const settings = await getSettings();
    return patch({
      status: "capturing",
      recording: true,
      startedAt: new Date(deps.now()).toISOString(),
      message: `Buffering the last ${Math.round(settings.clips.bufferSeconds / 60)} minutes. Detected moments become clips.`,
    });
  }

  /**
   * Recorder mode: this tab becomes StreamHunter's recorder. The editor's click (the popup) is the
   * only one needed; from then on the tab is navigated to whichever Auto-record streamer is live.
   */
  async function arm(tabId: number): Promise<CaptureState> {
    if ((await getCaptureState()).status !== "off") await stop();
    await setCaptureState({ ...INITIAL_CAPTURE_STATE, status: "starting", mode: "recorder", tabId });
    await launch(tabId, null);
    await patch({ status: "capturing", recording: false, startedAt: new Date(deps.now()).toISOString(), waitingReason: "Checking who is live…", message: null });
    return sync();
  }

  let lastSessionKey: string | null = null;

  /** Recorder mode: match the recorder tab to the live Auto-record streamers (after every check). */
  async function sync(): Promise<CaptureState> {
    const s = await getCaptureState();
    if (s.mode !== "recorder" || s.status !== "capturing" || s.tabId === null) return s;
    const monitoring = await getMonitoringState();
    const send = (m: OffscreenRequest) => deps.toOffscreen(m).catch(() => undefined);
    if (!monitoring.enabled) {
      await send({ target: "offscreen", type: "capture/target", capture: null });
      return patch({ recording: false, streamerId: null, channel: null, waitingReason: "Monitoring is stopped. Start monitoring to record automatically." });
    }
    if (monitoring.paused) {
      await send({ target: "offscreen", type: "capture/pause", paused: true });
      return patch({ recording: false, paused: true, waitingReason: "Monitoring is paused." });
    }
    if (s.paused) await send({ target: "offscreen", type: "capture/pause", paused: false });
    const streamers = await db.all<Streamer>("streamers");
    const next = pickRecordingTarget(streamers, s.streamerId);
    if (!next) {
      if (s.streamerId !== null || s.recording) await send({ target: "offscreen", type: "capture/target", capture: null });
      lastSessionKey = null;
      const any = streamers.some((x) => x.auto_record && x.monitoring_enabled);
      return patch({
        recording: false, paused: false, streamerId: null, channel: null,
        waitingReason: any ? "Waiting for an Auto-record streamer to go live." : "No streamer has Auto-record on. Turn it on in Streamers.",
      });
    }
    const { sessionKey, ...target } = await targetFor(next);
    const switching = next.id !== s.streamerId;
    // A new broadcast of the same streamer (stream restarted): reload the player too.
    const restarted = !switching && lastSessionKey !== null && sessionKey !== lastSessionKey;
    if (switching || restarted) await deps.navigate(s.tabId, streamUrl(next)).catch(() => undefined);
    lastSessionKey = sessionKey;
    await send({ target: "offscreen", type: "capture/target", capture: target });
    return patch({
      recording: true, paused: false, streamerId: next.id, platform: next.platform, channel: next.username.toLowerCase(), waitingReason: null,
      message: switching ? `Recording ${next.display_name}.` : restarted ? `${next.display_name} restarted the stream; recording again.` : s.message,
    });
  }

  async function stop(message: string | null = null): Promise<CaptureState> {
    await deps.toOffscreen({ target: "offscreen", type: "capture/stop" }).catch(() => undefined);
    await deps.closeOffscreen().catch(() => undefined);
    const s = await getCaptureState();
    lastSessionKey = null;
    return setCaptureState({ ...INITIAL_CAPTURE_STATE, clips: s.clips, message });
  }

  async function setPaused(paused: boolean): Promise<CaptureState> {
    const s = await getCaptureState();
    if (s.status !== "capturing") return s;
    await deps.toOffscreen({ target: "offscreen", type: "capture/pause", paused }).catch(() => undefined);
    const next = await patch({ paused, recording: !paused && (s.mode === "manual" || s.streamerId !== null) });
    return s.mode === "recorder" && !paused ? sync() : next;
  }

  async function applySettings(settings: Settings): Promise<void> {
    const s = await getCaptureState();
    if (s.status === "capturing") await deps.toOffscreen({ target: "offscreen", type: "capture/options", options: captureOptions(settings) }).catch(() => undefined);
  }

  /** "Save the last N seconds" from the popup. */
  async function saveLast(seconds: number): Promise<CaptureState> {
    const s = await getCaptureState();
    if (s.status !== "capturing" || s.streamerId === null || !s.recording) throw new Error("Nothing is being recorded right now");
    const streamer = await db.get<Streamer>("streamers", s.streamerId);
    if (!streamer) throw new Error("The captured streamer is no longer on the list");
    const now = deps.now();
    const session = await activeSessionFor(streamer.id);
    const h = await createHighlight({
      streamer, session: session ?? null, origin: "capture", peakAt: now, startAt: now - seconds * 1000, endAt: now,
      score: 70, confidence: 1, category: "other", reasons: ["Saved by you"],
      breakdown: { chat: null, audio: null, visual: null, context: null, active_signals: [], manual: true },
    });
    const request: ClipRequest = { highlightId: h.id, start: h.window_start_ms, end: h.window_end_ms, title: `${streamer.display_name} · Saved by you`, score: h.score };
    await deps.toOffscreen({ target: "offscreen", type: "capture/clip", request }).catch(() => undefined);
    return patch({ message: `Saving the last ${seconds} s…` });
  }

  /**
   * A highlight found elsewhere (chat, viewers). If that streamer is being recorded, it becomes a
   * signal for the fusion engine: combined with sound and picture it can make a clip (and is then
   * merged into it); alone it stays a provisional highlight.
   */
  async function onHighlight(h: LocalHighlight, s: Streamer): Promise<boolean> {
    const state = await getCaptureState();
    if (state.status !== "capturing" || !state.recording || state.streamerId !== s.id || h.origin === "capture") return false;
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
    await deps.toOffscreen({ target: "offscreen", type: "capture/signal", signal }).catch(() => undefined);
    return true;
  }

  async function onStatus(st: { bufferedSeconds: number; levelDb: number | null; recordedSeconds?: number; silentSeconds?: number }) {
    const s = await getCaptureState();
    if (s.status !== "capturing") return;
    const recorded = st.recordedSeconds ?? s.recordedSeconds;
    const delta = Math.max(0, recorded - s.recordedSeconds);
    if (delta > 0) {
      const stats = await getStats();
      await chrome.storage.local.set({ [STATS_KEY]: { recordedSeconds: stats.recordedSeconds + delta } });
    }
    await patch({ bufferedSeconds: st.bufferedSeconds, levelDb: st.levelDb, recordedSeconds: recorded, silentSeconds: st.silentSeconds ?? 0 });
  }

  async function onDetection(d: { at: number; reasons: string[]; score: number; clipped: boolean }) {
    await patch({ lastDetection: { at: new Date(d.at).toISOString(), reasons: d.reasons, score: d.score, clipped: d.clipped } });
  }

  async function onClipSaved(clipId: number, highlightId: number, durationSec: number) {
    const s = await getCaptureState();
    await patch({ clips: s.clips + 1, lastClipAt: new Date(deps.now()).toISOString(), message: `Clip saved (${Math.round(durationSec)} s).` });
    const h = await db.get<LocalHighlight>("highlights", highlightId);
    await deps.notify("Clip saved", `${h?.streamer_display_name ?? "Stream"}: ${h?.reasons[0] ?? "highlight"} (${Math.round(durationSec)} s)`, `sh-clip-${clipId}`);
    const settings = await getSettings();
    await enforceStorageLimits(settings.storage, new Date(deps.now())).catch(() => undefined);
    await deps.afterClip?.(clipId, highlightId).catch(() => undefined);
  }

  async function onClipFailed(reason: string) {
    await patch({ message: reason });
  }

  async function onEnded(reason: string) {
    const s = await getCaptureState();
    if (s.status === "off") return;
    if (s.mode === "recorder" && s.tabId !== null) {
      // Try to resume on the same tab (Chrome may still allow it); otherwise say what to do.
      try {
        await deps.closeOffscreen().catch(() => undefined);
        await launch(s.tabId, null);
        await patch({ status: "capturing", streamerId: null, recording: false, message: `Capture restarted (${reason}).` });
        await sync();
        return;
      } catch {
        await stop(`${reason} ${REARM_MESSAGE}`);
        return;
      }
    }
    await stop(reason);
  }

  async function onTabRemoved(tabId: number) {
    const s = await getCaptureState();
    if (s.status !== "off" && s.tabId === tabId) await stop(s.mode === "recorder" ? `The recorder tab was closed. ${REARM_MESSAGE}` : "The captured tab was closed.");
  }

  /** After a browser restart the capture is gone; never show a stale "capturing". */
  async function reset() {
    const s = await getCaptureState();
    if (s.status !== "off") await setCaptureState({ ...INITIAL_CAPTURE_STATE, clips: s.clips, message: s.mode === "recorder" ? `Chrome restarted. ${REARM_MESSAGE}` : null });
  }

  return { start, arm, sync, stop, setPaused, applySettings, saveLast, onHighlight, onStatus, onDetection, onClipSaved, onClipFailed, onEnded, onTabRemoved, reset };
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;
