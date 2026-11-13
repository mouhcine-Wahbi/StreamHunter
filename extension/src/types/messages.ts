import type { MonitoringState } from "./monitoring";

/** Messages UI surfaces send to the background service worker. */
export type RuntimeRequest =
  | { type: "monitoring/get" }
  | { type: "monitoring/start" }
  | { type: "monitoring/stop" }
  | { type: "monitoring/check-now" }
  | { type: "app/open"; route?: string };

export type RuntimeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface ResponseMap {
  "monitoring/get": MonitoringState;
  "monitoring/start": MonitoringState;
  "monitoring/stop": MonitoringState;
  "monitoring/check-now": MonitoringState;
  "app/open": null;
}

export const REQUEST_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set([
  "monitoring/get",
  "monitoring/start",
  "monitoring/stop",
  "monitoring/check-now",
  "app/open",
]);

export function isRuntimeRequest(v: unknown): v is RuntimeRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string" &&
    REQUEST_TYPES.has((v as { type: RuntimeRequest["type"] }).type)
  );
}
