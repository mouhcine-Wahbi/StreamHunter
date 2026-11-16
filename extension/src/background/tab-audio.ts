import { ApiClient, ApiError } from "@/services/api-client";
import { getAuthToken, getSettings, getTabAudioState, patchTabAudioState, setTabAudioState } from "@/store/storage";
import type { OffscreenRequest } from "@/types/messages";
import { channelFromUrl, INITIAL_TAB_AUDIO_STATE, type LoudnessSample, type TabAudioState } from "@/types/tab-audio";

const OFFSCREEN_URL = "offscreen.html";

export interface TabAudioDeps {
  now: () => Date;
  createClient: (baseUrl: string) => ApiClient;
  /** chrome.tabCapture.getMediaStreamId; needs the user to have invoked the extension on that tab. */
  streamIdFor: (tabId: number) => Promise<string>;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  toOffscreen: (message: OffscreenRequest) => Promise<{ ok: boolean; error?: string } | undefined>;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  return contexts.length > 0;
}

export const defaultTabAudioDeps: TabAudioDeps = {
  now: () => new Date(),
  createClient: (baseUrl) => new ApiClient({ baseUrl, getToken: getAuthToken }),
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
      justification: "Measure the loudness of the stream tab the editor chose (numbers only; audio is not recorded).",
    });
  },
  async closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  },
  toOffscreen: (message) => chrome.runtime.sendMessage(message),
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

/**
 * Live tab audio, driven by the worker. State lives in storage (the worker may be suspended
 * between batches); the offscreen document does the measuring and wakes the worker every ~5 s.
 */
export function createTabAudioManager(deps: TabAudioDeps = defaultTabAudioDeps) {
  async function start(tabId: number, url: string): Promise<TabAudioState> {
    const target = channelFromUrl(url);
    if (!target) throw new Error("Open a Twitch or Kick channel in this tab first");
    const current = await getTabAudioState();
    if (current.status !== "off") await stop();
    let streamId: string;
    try {
      streamId = await deps.streamIdFor(tabId);
    } catch (err) {
      throw new Error(`Chrome didn't allow capturing this tab's audio: ${describe(err)}`);
    }
    await deps.ensureOffscreen();
    const res = await deps.toOffscreen({ target: "offscreen", type: "meter/start", streamId });
    if (!res?.ok) {
      await deps.closeOffscreen();
      throw new Error(res?.error ?? "The audio meter did not start");
    }
    return setTabAudioState({
      ...INITIAL_TAB_AUDIO_STATE,
      status: "measuring",
      tabId,
      platform: target.platform,
      channel: target.channel,
      startedAt: deps.now().toISOString(),
      message: "Measuring… the first values arrive within a few seconds.",
    });
  }

  async function stop(message: string | null = null): Promise<TabAudioState> {
    await deps.toOffscreen({ target: "offscreen", type: "meter/stop" }).catch(() => undefined);
    await deps.closeOffscreen().catch(() => undefined);
    return setTabAudioState({ ...INITIAL_TAB_AUDIO_STATE, message });
  }

  async function onSamples(samples: LoudnessSample[]): Promise<TabAudioState> {
    const s = await getTabAudioState();
    if (s.status === "off" || !s.platform || !s.channel || samples.length === 0) return s;
    const levelDb = samples[samples.length - 1]?.db ?? null;
    const client = deps.createClient((await getSettings()).backendUrl);
    const at = deps.now().toISOString();
    try {
      await client.post("/api/v1/monitoring/audio", { platform: s.platform, channel: s.channel, sent_at: at, samples });
      return patchTabAudioState({ status: "measuring", lastSentAt: at, levelDb, message: null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return stop("Sign in to StreamHunter to use tab audio.");
      if (err instanceof ApiError && err.status === 404)
        return patchTabAudioState({ status: "waiting", levelDb, message: err.message });
      return patchTabAudioState({
        status: "error",
        levelDb,
        message: err instanceof ApiError && err.isHttp ? err.message : "Backend not reachable; still measuring.",
      });
    }
  }

  async function onEnded(reason: string): Promise<TabAudioState> {
    const s = await getTabAudioState();
    return s.status === "off" ? s : stop(reason);
  }

  async function onTabRemoved(tabId: number): Promise<void> {
    const s = await getTabAudioState();
    if (s.status !== "off" && s.tabId === tabId) await stop("The measured tab was closed.");
  }

  /** After a browser restart the capture is gone; never show a stale "measuring". */
  async function reset(): Promise<void> {
    const s = await getTabAudioState();
    if (s.status !== "off") await setTabAudioState({ ...INITIAL_TAB_AUDIO_STATE });
  }

  return { start, stop, onSamples, onEnded, onTabRemoved, reset };
}

export type TabAudioManager = ReturnType<typeof createTabAudioManager>;
