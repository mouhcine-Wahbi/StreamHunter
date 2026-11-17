import { getMonitoringState } from "@/store/storage";
import { isRuntimeRequest, type RuntimeResponse } from "@/types/messages";
import type { MonitoringManager } from "./monitoring-manager";
import { getCaptureState, type CaptureManager } from "./capture-manager";

const NO_CAPTURE = "Capture is only available in the installed extension";

export async function handleMessage(
  message: unknown,
  manager: MonitoringManager,
  capture?: CaptureManager,
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
        return { ok: true, data: state.enabled ? await manager.tick(true) : await manager.checkOnce() };
      }
      case "app/open": {
        const route = message.route && /^\/[a-z-]*$/.test(message.route) ? message.route : "/overview";
        await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${route}`) });
        return { ok: true, data: null };
      }
      case "capture/get":
        return { ok: true, data: await getCaptureState() };
      case "capture/start":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        if (!Number.isInteger(message.tabId) || typeof message.url !== "string") return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await capture.start(message.tabId, message.url) };
      case "capture/stop":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        return { ok: true, data: await capture.stop() };
      case "capture/save-last": {
        if (!capture) return { ok: false, error: NO_CAPTURE };
        const seconds = Math.max(5, Math.min(110, Number(message.seconds) || 30));
        return { ok: true, data: await capture.saveLast(seconds) };
      }
      case "capture/status":
        await capture?.onStatus(Number(message.bufferedSeconds) || 0, typeof message.levelDb === "number" ? message.levelDb : null);
        return { ok: true, data: null };
      case "capture/clip-saved":
        await capture?.onClipSaved(Number(message.clipId), Number(message.highlightId), Number(message.durationSec) || 0);
        return { ok: true, data: null };
      case "capture/clip-failed":
        await capture?.onClipFailed(String(message.reason));
        return { ok: true, data: null };
      case "capture/ended":
        await capture?.onEnded(String(message.reason));
        return { ok: true, data: null };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

/** Only accept messages from this extension's own pages. */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
