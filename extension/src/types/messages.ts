import type { MonitoringState } from "./monitoring";
import type { CaptureOptions, CaptureState, CaptureTarget, ClipRequest } from "./capture";

/** Messages UI surfaces (and the offscreen document) send to the background service worker. */
export type RuntimeRequest =
  | { type: "monitoring/get" }
  | { type: "monitoring/start" }
  | { type: "monitoring/stop" }
  | { type: "monitoring/check-now" }
  | { type: "app/open"; route?: string }
  // Capture mode (popup → worker; the popup click is what lets Chrome capture the tab).
  | { type: "capture/get" }
  | { type: "capture/start"; tabId: number; url: string }
  | { type: "capture/stop" }
  | { type: "capture/save-last"; seconds: number }
  // From the offscreen capture engine to the worker.
  | { type: "capture/status"; bufferedSeconds: number; levelDb: number | null }
  | { type: "capture/clip-saved"; clipId: number; highlightId: number; durationSec: number }
  | { type: "capture/clip-failed"; highlightId: number; reason: string }
  | { type: "capture/ended"; reason: string };

/** Messages the worker sends to the offscreen document (never handled by the worker). */
export type OffscreenRequest =
  | { target: "offscreen"; type: "capture/start"; streamId: string; capture: CaptureTarget; options: CaptureOptions }
  | { target: "offscreen"; type: "capture/clip"; request: ClipRequest }
  | { target: "offscreen"; type: "capture/stop" };

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface ResponseMap {
  "monitoring/get": MonitoringState;
  "monitoring/start": MonitoringState;
  "monitoring/stop": MonitoringState;
  "monitoring/check-now": MonitoringState;
  "app/open": null;
  "capture/get": CaptureState;
  "capture/start": CaptureState;
  "capture/stop": CaptureState;
  "capture/save-last": CaptureState;
  "capture/status": null;
  "capture/clip-saved": null;
  "capture/clip-failed": null;
  "capture/ended": null;
}

export const REQUEST_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set([
  "monitoring/get",
  "monitoring/start",
  "monitoring/stop",
  "monitoring/check-now",
  "app/open",
  "capture/get",
  "capture/start",
  "capture/stop",
  "capture/save-last",
  "capture/status",
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
