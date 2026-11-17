import type { MonitoringState } from "./monitoring";
import type { LoudnessSample, PcmChunk, TabAudioState } from "./tab-audio";

/** Messages UI surfaces send to the background service worker. */
export type RuntimeRequest =
  | { type: "monitoring/get" }
  | { type: "monitoring/start" }
  | { type: "monitoring/stop" }
  | { type: "monitoring/check-now" }
  | { type: "app/open"; route?: string }
  // Live tab audio (popup → worker; the popup click is what lets Chrome capture the tab).
  | { type: "tab-audio/get" }
  | { type: "tab-audio/start"; tabId: number; url: string; sounds?: boolean }
  | { type: "tab-audio/stop" }
  // From the offscreen loudness meter to the worker.
  | { type: "tab-audio/samples"; samples: LoudnessSample[]; pcm?: PcmChunk }
  | { type: "tab-audio/ended"; reason: string };

/** Messages the worker sends to the offscreen document (never handled by the worker). */
export type OffscreenRequest =
  | { target: "offscreen"; type: "meter/start"; streamId: string; sounds: boolean }
  | { target: "offscreen"; type: "meter/stop" };

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface ResponseMap {
  "monitoring/get": MonitoringState;
  "monitoring/start": MonitoringState;
  "monitoring/stop": MonitoringState;
  "monitoring/check-now": MonitoringState;
  "app/open": null;
  "tab-audio/get": TabAudioState;
  "tab-audio/start": TabAudioState;
  "tab-audio/stop": TabAudioState;
  "tab-audio/samples": TabAudioState;
  "tab-audio/ended": TabAudioState;
}

export const REQUEST_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set([
  "monitoring/get",
  "monitoring/start",
  "monitoring/stop",
  "monitoring/check-now",
  "app/open",
  "tab-audio/get",
  "tab-audio/start",
  "tab-audio/stop",
  "tab-audio/samples",
  "tab-audio/ended",
]);

export function isRuntimeRequest(v: unknown): v is RuntimeRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string" &&
    REQUEST_TYPES.has((v as { type: RuntimeRequest["type"] }).type)
  );
}
