import { getMonitoringState } from "@/store/storage";
import { isRuntimeRequest, type RuntimeResponse } from "@/types/messages";
import type { MonitoringManager } from "./monitoring-manager";

export async function handleMessage(message: unknown, manager: MonitoringManager): Promise<RuntimeResponse> {
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
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

/** Only accept messages from this extension's own pages. */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
