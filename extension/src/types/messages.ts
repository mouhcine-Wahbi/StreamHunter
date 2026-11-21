import type { MonitoringState } from "./monitoring";
import type { CaptureOptions, CaptureState, CaptureTarget, ClipRequest, SlotHealth, SystemLoad } from "./capture";
import type { Signal } from "@/detection/fusion";
import type { Approval } from "@/local/approvals";
import type { DiscoveryRun } from "@/discovery/discovery";
import type { SourceFile } from "@/local/sources";

/** Messages UI surfaces (and the offscreen document) send to the background service worker. */
export type RuntimeRequest =
  | { type: "monitoring/get" }
  | { type: "monitoring/start" }
  | { type: "monitoring/stop" }
  | { type: "monitoring/pause" }
  | { type: "monitoring/resume" }
  | { type: "monitoring/check-now" }
  | { type: "app/open"; route?: string }
  // Recording approvals (3.0).
  | { type: "approval/decide"; id: string; action: "approve" | "decline" | "remind" | "stop" }
  // Content discovery (3.0).
  | { type: "discovery/run"; sources?: ("creator_uploads" | "trending" | "keyword")[] }
  // Authorized source files (3.0): find moments, cut a clip.
  | { type: "source/analyze"; id: number }
  | { type: "source/clip"; id: number; start: number; end: number }
  // Capture mode (popup → worker; the popup click is what lets Chrome capture the tab).
  | { type: "capture/get"; tabId?: number }
  | { type: "capture/list" }
  | { type: "capture/start"; tabId: number; url: string }
  | { type: "capture/arm"; tabId: number }
  | { type: "capture/sync" }
  | { type: "capture/stop"; tabId?: number }
  | { type: "capture/pause-slot"; tabId: number; paused: boolean }
  | { type: "capture/listen"; tabId: number; on: boolean }
  | { type: "capture/save-last"; seconds: number; tabId?: number }
  | { type: "system/get" }
  // From the offscreen capture engine to the worker.
  | { type: "capture/status"; slot?: number; bufferedSeconds: number; levelDb: number | null; recording?: boolean; recordedSeconds?: number; silentSeconds?: number; health?: SlotHealth }
  | { type: "capture/detection"; slot?: number; at: number; reasons: string[]; score: number; clipped: boolean }
  | { type: "capture/clip-saved"; slot?: number; clipId: number; highlightId: number; durationSec: number }
  | { type: "capture/clip-failed"; slot?: number; highlightId: number; reason: string }
  | { type: "capture/ended"; slot?: number; reason: string };

/** Messages the worker sends to the offscreen document (never handled by the worker).
 * `slot` is the captured tab's id: one engine per slot. Without a slot, capture/stop stops all. */
export type OffscreenRequest =
  | { target: "offscreen"; type: "capture/start"; slot: number; streamId: string; capture: CaptureTarget | null; options: CaptureOptions }
  | { target: "offscreen"; type: "capture/clip"; slot: number; request: ClipRequest }
  | { target: "offscreen"; type: "capture/signal"; slot: number; signal: Signal }
  | { target: "offscreen"; type: "capture/target"; slot: number; capture: CaptureTarget | null }
  | { target: "offscreen"; type: "capture/pause"; slot: number; paused: boolean }
  | { target: "offscreen"; type: "capture/listen"; slot: number; on: boolean }
  | { target: "offscreen"; type: "capture/throttle"; slot: number; on: boolean }
  | { target: "offscreen"; type: "capture/options"; slot: number; options: CaptureOptions }
  | { target: "offscreen"; type: "capture/stop"; slot?: number };

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface ResponseMap {
  "monitoring/get": MonitoringState;
  "monitoring/start": MonitoringState;
  "monitoring/stop": MonitoringState;
  "monitoring/pause": MonitoringState;
  "monitoring/resume": MonitoringState;
  "monitoring/check-now": MonitoringState;
  "app/open": null;
  "approval/decide": Approval;
  "discovery/run": DiscoveryRun;
  "source/analyze": SourceFile;
  "source/clip": { clipId: number };
  "capture/get": CaptureState;
  "capture/list": CaptureState[];
  "capture/pause-slot": CaptureState;
  "capture/listen": CaptureState;
  "system/get": SystemLoad | null;
  "capture/start": CaptureState;
  "capture/arm": CaptureState;
  "capture/sync": CaptureState;
  "capture/stop": CaptureState;
  "capture/save-last": CaptureState;
  "capture/status": null;
  "capture/detection": null;
  "capture/clip-saved": null;
  "capture/clip-failed": null;
  "capture/ended": null;
}

export const REQUEST_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set([
  "monitoring/get",
  "monitoring/start",
  "monitoring/stop",
  "monitoring/pause",
  "monitoring/resume",
  "monitoring/check-now",
  "app/open",
  "approval/decide",
  "discovery/run",
  "source/analyze",
  "source/clip",
  "capture/get",
  "capture/list",
  "capture/pause-slot",
  "capture/listen",
  "system/get",
  "capture/start",
  "capture/arm",
  "capture/sync",
  "capture/stop",
  "capture/save-last",
  "capture/status",
  "capture/detection",
  "capture/clip-saved",
  "capture/clip-failed",
  "capture/ended",
]);

export function isRuntimeRequest(v: unknown): v is RuntimeRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string" &&
    REQUEST_TYPES.has((v as { type: RuntimeRequest["type"] }).type)
  );
}
