import { getMonitoringState, getSettings } from "@/store/storage";
import { runDiscovery } from "@/discovery/runner";
import { isRuntimeRequest, type RuntimeResponse } from "@/types/messages";
import type { MonitoringManager } from "./monitoring-manager";
import { getCaptureState, getSlots, type CaptureManager } from "./capture-manager";
import { SYSTEM_KEY, type SystemLoad } from "@/types/capture";
import { ApprovalError, type Approval, type ApprovalAction } from "@/local/approvals";
import { requestAnalysis, requestSourceClip } from "@/local/sources";
import { RightsError } from "@/local/rights";
import { ProcessingError, type ProcessingManager } from "./processing-manager";
import type { ContentManager } from "./content-manager";
import { ContentError } from "@/local/content";

const NO_CAPTURE = "Capture is only available in the installed extension";

export async function handleMessage(
  message: unknown,
  manager: MonitoringManager,
  capture?: CaptureManager,
  /** Overload protection hook (runs at most every 10 s, on engine reports). */
  onLoad?: () => Promise<void>,
  /** Recording approvals (3.0): apply your decision and reschedule. */
  decide?: (id: string, action: ApprovalAction) => Promise<Approval>,
  /** 3.0 processing queue (formats, analyses of authorized files). */
  processing?: ProcessingManager,
  /** 3.0 metadata and score. */
  content?: ContentManager,
  /** 3.0 publishing: runs due jobs. */
  publish?: () => Promise<{ processed: number }>,
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
      case "approval/decide": {
        if (!decide) return { ok: false, error: "Recording requests are only available in the installed extension" };
        if (typeof message.id !== "string" || !["approve", "decline", "remind", "stop"].includes(message.action)) return { ok: false, error: "Invalid request" };
        try {
          return { ok: true, data: await decide(message.id, message.action) };
        } catch (e) {
          return { ok: false, error: e instanceof ApprovalError ? e.message : e instanceof Error ? e.message : "Unexpected error" };
        }
      }
      case "discovery/run": {
        const sources = Array.isArray(message.sources) ? message.sources.filter((x) => ["creator_uploads", "trending", "keyword"].includes(x)) : undefined;
        return { ok: true, data: await runDiscovery(await getSettings(), { sources }) };
      }
      case "source/analyze":
      case "source/clip":
      case "assets/make": {
        if (!processing) return { ok: false, error: "Processing is only available in the installed extension" };
        try {
          if (message.type === "assets/make") {
            const kinds = Array.isArray(message.kinds) ? message.kinds.filter((k) => k === "vertical" || k === "landscape") : undefined;
            return { ok: true, data: await processing.makeAssets(Number(message.clipId), await getSettings(), kinds, message.layout ?? null) };
          }
          const id = Number(message.id);
          const data =
            message.type === "source/analyze"
              ? await requestAnalysis(id)
              : await requestSourceClip(id, { start: Number(message.start), end: Number(message.end), title: message.title, score: message.score, reasons: message.reasons });
          await processing.kick();
          return { ok: true, data };
        } catch (e) {
          if (e instanceof RightsError || e instanceof ProcessingError) return { ok: false, error: e.message };
          throw e;
        }
      }
      case "metadata/generate":
        if (!content) return { ok: false, error: "Metadata is only available in the installed extension" };
        try {
          return { ok: true, data: await content.prepare(Number(message.clipId), await getSettings(), { regenerate: true, resetEdits: Boolean(message.resetEdits) }) };
        } catch (e) {
          if (e instanceof ContentError) return { ok: false, error: e.message };
          throw e;
        }
      case "publish/run":
        if (!publish) return { ok: false, error: "Publishing is only available in the installed extension" };
        return { ok: true, data: await publish() };
      case "ai/status":
        return { ok: true, data: content ? await content.status() : { onDevice: "absent", where: null } };
      case "process/clip-made":
      case "process/asset-done":
      case "process/idle":
        await processing?.onEvent(message, await getSettings());
        return { ok: true, data: null };
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
            staticSeconds: Number(message.health.staticSeconds) || 0,
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
        await processing?.onClipSaved(Number(message.clipId), await getSettings());
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
