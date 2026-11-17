import { getMonitoringState, getTabAudioState } from "@/store/storage";
import { isRuntimeRequest, type RuntimeResponse } from "@/types/messages";
import type { MonitoringManager } from "./monitoring-manager";
import type { PcmChunk } from "@/types/tab-audio";
import type { TabAudioManager } from "./tab-audio";

const NO_TAB_AUDIO = "Tab audio is only available in the installed extension";

export async function handleMessage(
  message: unknown,
  manager: MonitoringManager,
  tabAudio?: TabAudioManager,
): Promise<RuntimeResponse> {
  if (!isRuntimeRequest(message)) return { ok: false, error: "Unknown message" };
  try {
    switch (message.type) {
      case "monitoring/get":
        return { ok: true, data: await getMonitoringState() };
      case "monitoring/start":
        return { ok: true, data: await manager.start() };
      case "monitoring/stop":
        return { ok: true, data: await manager.stop() };
      case "monitoring/check-now": {
        const state = await getMonitoringState();
        return { ok: true, data: state.enabled ? await manager.tick(true) : await manager.checkBackend() };
      }
      case "app/open": {
        const route = message.route && /^\/[a-z-]*$/.test(message.route) ? message.route : "/overview";
        await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${route}`) });
        return { ok: true, data: null };
      }
      case "tab-audio/get":
        return { ok: true, data: await getTabAudioState() };
      case "tab-audio/start":
        if (!tabAudio) return { ok: false, error: NO_TAB_AUDIO };
        if (!Number.isInteger(message.tabId) || typeof message.url !== "string") return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await tabAudio.start(message.tabId, message.url, { sounds: message.sounds === true }) };
      case "tab-audio/stop":
        if (!tabAudio) return { ok: false, error: NO_TAB_AUDIO };
        return { ok: true, data: await tabAudio.stop() };
      case "tab-audio/samples":
        if (!tabAudio) return { ok: false, error: NO_TAB_AUDIO };
        if (!Array.isArray(message.samples)) return { ok: false, error: "Invalid samples" };
        return {
          ok: true,
          data: await tabAudio.onSamples(
            message.samples
              .filter((x) => typeof x?.t === "string" && typeof x?.db === "number" && Number.isFinite(x.db))
              .slice(0, 120),
            validPcm(message.pcm),
          ),
        };
      case "tab-audio/ended":
        if (!tabAudio) return { ok: false, error: NO_TAB_AUDIO };
        return { ok: true, data: await tabAudio.onEnded(String(message.reason)) };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

function validPcm(pcm: unknown): PcmChunk | undefined {
  const p = pcm as Partial<PcmChunk> | null | undefined;
  if (!p || typeof p.start !== "string" || typeof p.data !== "string" || p.data.length > 600_000) return undefined;
  return { start: p.start, data: p.data };
}

/** Only accept messages from this extension's own pages. */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
