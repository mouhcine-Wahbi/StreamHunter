import { db } from "@/local/db";
import { createHighlight, type LocalHighlight } from "@/local/highlights";
import { activeSessionFor } from "@/local/sessions";
import { addStreamer, platformClients, resolveChannel } from "@/local/streamers";
import { getSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import { CAPTURE_KEY, channelFromUrl, INITIAL_CAPTURE_STATE, type CaptureState, type CaptureTarget, type ClipRequest } from "@/types/capture";
import type { OffscreenRequest } from "@/types/messages";

const OFFSCREEN_URL = "offscreen.html";
export const BUFFER_SECONDS = 120;

export interface CaptureDeps {
  now: () => number;
  /** chrome.tabCapture.getMediaStreamId; needs the editor to have invoked the extension on that tab. */
  streamIdFor: (tabId: number) => Promise<string>;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  toOffscreen: (message: OffscreenRequest) => Promise<{ ok: boolean; error?: string } | undefined>;
  notify: (title: string, message: string, id?: string) => Promise<void>;
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

/** Capture mode, driven by the worker. State lives in storage (the worker may sleep in between). */
export function createCaptureManager(deps: CaptureDeps = defaultCaptureDeps) {
  async function start(tabId: number, url: string): Promise<CaptureState> {
    const target = channelFromUrl(url);
    if (!target) throw new Error("Open a Twitch or Kick channel in this tab first");
    if ((await getCaptureState()).status !== "off") await stop();
    let streamId: string;
    try {
      streamId = await deps.streamIdFor(tabId);
    } catch (e) {
      throw new Error(`Chrome didn't allow capturing this tab: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    const streamer = await streamerFor(target.platform, target.channel);
    const session = await activeSessionFor(streamer.id);
    const settings = await getSettings();
    const capture: CaptureTarget = {
      streamerId: streamer.id, sessionId: session?.id ?? null, platform: streamer.platform, displayName: streamer.display_name,
      username: streamer.username, broadcastStartedAt: session?.broadcast_started_at ?? streamer.stream_started_at,
    };
    await setCaptureState({ ...INITIAL_CAPTURE_STATE, status: "starting", tabId, platform: target.platform, channel: target.channel, streamerId: streamer.id });
    await deps.ensureOffscreen();
    const res = await deps.toOffscreen({
      target: "offscreen", type: "capture/start", streamId, capture,
      options: { bufferSeconds: BUFFER_SECONDS, preRollSeconds: settings.clips.preRollSeconds, postRollSeconds: settings.clips.postRollSeconds, minScore: settings.detection.minHighlightScore },
    });
    if (!res?.ok) {
      await deps.closeOffscreen();
      await setCaptureState({ ...INITIAL_CAPTURE_STATE, status: "error", message: res?.error ?? "The capture did not start" });
      throw new Error(res?.error ?? "The capture did not start");
    }
    return patch({
      status: "capturing",
      startedAt: new Date(deps.now()).toISOString(),
      message: `Buffering the last ${BUFFER_SECONDS / 60} minutes. Detected moments become clips.`,
    });
  }

  async function stop(message: string | null = null): Promise<CaptureState> {
    await deps.toOffscreen({ target: "offscreen", type: "capture/stop" }).catch(() => undefined);
    await deps.closeOffscreen().catch(() => undefined);
    const s = await getCaptureState();
    return setCaptureState({ ...INITIAL_CAPTURE_STATE, clips: s.clips, message });
  }

  /** "Save the last N seconds" from the popup. */
  async function saveLast(seconds: number): Promise<CaptureState> {
    const s = await getCaptureState();
    if (s.status !== "capturing" || s.streamerId === null) throw new Error("Start a capture first");
    const streamer = await db.get<Streamer>("streamers", s.streamerId);
    if (!streamer) throw new Error("The captured streamer is no longer on the list");
    const now = deps.now();
    const session = await activeSessionFor(streamer.id);
    const h = await createHighlight({
      streamer, session: session ?? null, origin: "capture", peakAt: now, startAt: now - seconds * 1000, endAt: now,
      score: 70, confidence: 1, category: "other", reasons: ["Saved by you"],
      breakdown: { chat: null, audio: null, visual: null, context: null, active_signals: [], manual: true },
    });
    await requestClip(h, streamer);
    return patch({ message: `Saving the last ${seconds} s…` });
  }

  async function requestClip(h: LocalHighlight, s: Pick<Streamer, "display_name">) {
    const request: ClipRequest = {
      highlightId: h.id,
      start: h.window_start_ms,
      end: h.window_end_ms,
      title: `${s.display_name} · ${h.reasons[0] ?? h.category}`,
      score: h.score,
    };
    await deps.toOffscreen({ target: "offscreen", type: "capture/clip", request }).catch(() => undefined);
  }

  /** A highlight found elsewhere (chat, viewers): if that streamer is being captured, clip it. */
  async function onHighlight(h: LocalHighlight, s: Streamer): Promise<boolean> {
    const state = await getCaptureState();
    if (state.status !== "capturing" || state.streamerId !== s.id || h.origin === "capture") return false;
    await requestClip(h, s);
    return true;
  }

  async function onStatus(bufferedSeconds: number, levelDb: number | null) {
    const s = await getCaptureState();
    if (s.status === "capturing") await patch({ bufferedSeconds, levelDb });
  }

  async function onClipSaved(clipId: number, highlightId: number, durationSec: number) {
    const s = await getCaptureState();
    await patch({ clips: s.clips + 1, lastClipAt: new Date(deps.now()).toISOString(), message: `Clip saved (${Math.round(durationSec)} s).` });
    const h = await db.get<LocalHighlight>("highlights", highlightId);
    await deps.notify("Clip saved", `${h?.streamer_display_name ?? "Stream"}: ${h?.reasons[0] ?? "highlight"} (${Math.round(durationSec)} s)`, `sh-clip-${clipId}`);
  }

  async function onClipFailed(reason: string) {
    await patch({ message: reason });
  }

  async function onEnded(reason: string) {
    const s = await getCaptureState();
    if (s.status !== "off") await stop(reason);
  }

  async function onTabRemoved(tabId: number) {
    const s = await getCaptureState();
    if (s.status !== "off" && s.tabId === tabId) await stop("The captured tab was closed.");
  }

  /** After a browser restart the capture is gone; never show a stale "capturing". */
  async function reset() {
    const s = await getCaptureState();
    if (s.status !== "off") await setCaptureState({ ...INITIAL_CAPTURE_STATE, clips: s.clips });
  }

  return { start, stop, saveLast, onHighlight, onStatus, onClipSaved, onClipFailed, onEnded, onTabRemoved, reset };
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;
