import { getMonitoringState } from "@/store/storage";
import { isRuntimeRequest, type RuntimeResponse } from "@/types/messages";
import type { MonitoringManager } from "./monitoring-manager";
import { getCaptureState, getSlots, type CaptureManager } from "./capture-manager";
import { SYSTEM_KEY, type SystemLoad } from "@/types/capture";

const NO_CAPTURE = "Capture is only available in the installed extension";

export async function handleMessage(
  message: unknown,
  manager: MonitoringManager,
  capture?: CaptureManager,
  /** Overload protection hook (runs at most every 10 s, on engine reports). */
  onLoad?: () => Promise<void>,
): Promise<RuntimeResponse> {
  if (!isRuntimeRequest(message)) return { ok: false, error: "Unknown message" };
  try {
    switch (message.type) {
      case "monitoring/get":
        return { ok: true, data: await getMonitoringState() };
      case "monitoring/start":
        return { ok: true, data: await manager.start() };
      case "monitoring/stop": {
        const data = await manager.stop();
        await capture?.sync();
        return { ok: true, data };
      }
      case "monitoring/pause": {
        const data = await manager.pause();
        await capture?.setPaused(true);
        return { ok: true, data };
      }
      case "monitoring/resume": {
        const data = await manager.resume();
        await capture?.setPaused(false);
        return { ok: true, data };
      }
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
        return { ok: true, data: await getCaptureState(Number.isInteger(message.tabId) ? message.tabId : undefined) };
      case "capture/list":
        return { ok: true, data: await getSlots() };
      case "capture/pause-slot":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        if (!Number.isInteger(message.tabId)) return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await capture.setPaused(Boolean(message.paused), message.tabId, "you") };
      case "capture/listen":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        if (!Number.isInteger(message.tabId)) return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await capture.setListening(message.tabId, Boolean(message.on)) };
      case "system/get":
        return { ok: true, data: (((await chrome.storage.local.get(SYSTEM_KEY))[SYSTEM_KEY] ?? null) as SystemLoad | null) };
      case "capture/start":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        if (!Number.isInteger(message.tabId) || typeof message.url !== "string") return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await capture.start(message.tabId, message.url) };
      case "capture/arm":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        if (!Number.isInteger(message.tabId)) return { ok: false, error: "Invalid tab" };
        return { ok: true, data: await capture.arm(message.tabId) };
      case "capture/sync":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        return { ok: true, data: await capture.sync() };
      case "capture/stop":
        if (!capture) return { ok: false, error: NO_CAPTURE };
        return { ok: true, data: await capture.stop(Number.isInteger(message.tabId) ? message.tabId : undefined) };
      case "capture/save-last": {
        if (!capture) return { ok: false, error: NO_CAPTURE };
        const seconds = Math.max(5, Math.min(110, Number(message.seconds) || 30));
        return { ok: true, data: await capture.saveLast(seconds, Number.isInteger(message.tabId) ? message.tabId : undefined) };
      }
      case "capture/status":
        await capture?.onStatus(Number(message.slot), {
          bufferedSeconds: Number(message.bufferedSeconds) || 0,
          levelDb: typeof message.levelDb === "number" ? message.levelDb : null,
          recordedSeconds: typeof message.recordedSeconds === "number" ? message.recordedSeconds : undefined,
          silentSeconds: typeof message.silentSeconds === "number" ? message.silentSeconds : undefined,
          health: message.health && typeof message.health === "object" ? {
            fps: Number(message.health.fps) || 0, dropped: Number(message.health.dropped) || 0,
            queue: Number(message.health.queue) || 0, throttled: Boolean(message.health.throttled),
            droppedRecent: Number(message.health.droppedRecent) || 0, pendingClips: Number(message.health.pendingClips) || 0,
            noVideoSeconds: Number(message.health.noVideoSeconds) || 0, blackSeconds: Number(message.health.blackSeconds) || 0,
          } : undefined,
        });
        await onLoad?.();
        return { ok: true, data: null };
      case "capture/detection":
        await capture?.onDetection(Number(message.slot), {
          at: Number(message.at) || Date.now(),
          reasons: Array.isArray(message.reasons) ? message.reasons.map(String).slice(0, 8) : [],
          score: Number(message.score) || 0,
          clipped: Boolean(message.clipped),
        });
        return { ok: true, data: null };
      case "capture/clip-saved":
        await capture?.onClipSaved(Number(message.slot), Number(message.clipId), Number(message.highlightId), Number(message.durationSec) || 0);
        return { ok: true, data: null };
      case "capture/clip-failed":
        await capture?.onClipFailed(Number(message.slot), String(message.reason));
        return { ok: true, data: null };
      case "capture/ended":
        await capture?.onEnded(Number(message.slot), String(message.reason));
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
