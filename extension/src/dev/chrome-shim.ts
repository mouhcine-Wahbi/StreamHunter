/**
 * Browser preview only (npm run preview:web). Never part of the extension build.
 *
 * Supplies the subset of chrome.* APIs StreamHunter uses so the real extension
 * pages can run in a normal tab on localhost:
 *   - storage.local  → window.localStorage (+ change events across tabs)
 *   - alarms         → setTimeout/setInterval in this tab
 *   - runtime.sendMessage → the real background message handler, run in-page
 * Backend calls are real HTTP requests; nothing here fabricates data.
 */
import { handleMessage } from "@/background/message-handler";
import { createMonitoringManager } from "@/background/monitoring-manager";
import { ALARMS } from "@/background/alarm-manager";

type Listener = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

function event() {
  const ls = new Set<Listener>();
  return {
    addListener: (l: Listener) => void ls.add(l),
    removeListener: (l: Listener) => void ls.delete(l),
    hasListener: (l: Listener) => ls.has(l),
    emit: (...a: unknown[]) => [...ls].forEach((l) => l(...a)),
  };
}

const PREFIX = "sh-preview:";
const storageChanged = event();
const onAlarm = event();
const timers = new Map<string, { alarm: chrome.alarms.Alarm; handle: number }>();

const readKey = (k: string): unknown => {
  const raw = localStorage.getItem(PREFIX + k);
  return raw === null ? undefined : JSON.parse(raw);
};

window.addEventListener("storage", (e) => {
  if (!e.key?.startsWith(PREFIX)) return;
  const k = e.key.slice(PREFIX.length);
  storageChanged.emit(
    { [k]: { oldValue: e.oldValue ? JSON.parse(e.oldValue) : undefined, newValue: e.newValue ? JSON.parse(e.newValue) : undefined } },
    "local",
  );
});

const shim = {
  storage: {
    local: {
      async get(keys?: string | string[] | null) {
        const list =
          keys == null
            ? Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
            : Array.isArray(keys)
              ? keys
              : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) {
          const v = readKey(k);
          if (v !== undefined) out[k] = v;
        }
        return out;
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: readKey(k), newValue: v };
          localStorage.setItem(PREFIX + k, JSON.stringify(v));
        }
        storageChanged.emit(changes, "local");
      },
      async remove(keys: string | string[]) {
        const changes: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          changes[k] = { oldValue: readKey(k) };
          localStorage.removeItem(PREFIX + k);
        }
        storageChanged.emit(changes, "local");
      },
    },
    onChanged: storageChanged,
  },
  alarms: {
    async create(name: string, info: chrome.alarms.AlarmCreateInfo) {
      const prev = timers.get(name);
      if (prev) clearInterval(prev.handle);
      const periodMs = (info.periodInMinutes ?? info.delayInMinutes ?? 1) * 60_000;
      const alarm: chrome.alarms.Alarm = { name, scheduledTime: Date.now() + periodMs, periodInMinutes: info.periodInMinutes };
      const handle = window.setInterval(() => onAlarm.emit(alarm), periodMs);
      timers.set(name, { alarm, handle });
    },
    async get(name: string) {
      return timers.get(name)?.alarm;
    },
    async getAll() {
      return [...timers.values()].map((t) => t.alarm);
    },
    async clear(name: string) {
      const t = timers.get(name);
      if (t) clearInterval(t.handle);
      return timers.delete(name);
    },
    onAlarm,
  },
  runtime: {
    id: "streamhunter-preview",
    getURL: (p: string) => new URL(`/${p}`, location.origin).toString(),
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    async sendMessage(message: unknown) {
      return handleMessage(message, manager);
    },
  },
  tabs: {
    async create({ url }: { url: string }) {
      window.open(url, "_blank");
      return { id: 1, url };
    },
  },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  },
  sidePanel: {
    open: async () => void window.open("/sidepanel.html", "_blank", "width=400,height=760"),
    setPanelBehavior: async () => undefined,
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { request: async () => true },
};

(globalThis as unknown as { chrome: unknown }).chrome = shim;

// The "background worker" for this tab: same manager and handler as the real service worker.
const manager = createMonitoringManager();
onAlarm.addListener((a: chrome.alarms.Alarm) => a.name === ALARMS.heartbeat && void manager.tick());
void manager.restore();

// window.close() is a no-op for normal tabs; keep the popup visible in preview.
window.close = () => undefined;

// Label the preview clearly so it is never mistaken for the installed extension.
window.addEventListener("DOMContentLoaded", () => {
  const tag = document.createElement("div");
  tag.textContent = "Browser preview · Chrome extension APIs simulated · load extension/dist in Chrome for the real thing";
  tag.setAttribute("role", "note");
  tag.style.cssText =
    "position:fixed;bottom:8px;right:8px;z-index:9999;padding:4px 10px;border-radius:999px;font:500 11px system-ui;" +
    "background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b55;pointer-events:none";
  document.body.appendChild(tag);
});
