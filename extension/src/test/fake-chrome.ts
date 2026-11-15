/**
 * In-memory fake of the subset of the Chrome extension APIs StreamHunter uses.
 * Behaviour mirrors Chrome closely enough for unit tests: storage change events,
 * alarm registry, runtime messaging routed to registered listeners.
 */
type Listener<A extends unknown[]> = (...args: A) => unknown;

class Event<A extends unknown[]> {
  listeners = new Set<Listener<A>>();
  addListener = (l: Listener<A>) => void this.listeners.add(l);
  removeListener = (l: Listener<A>) => void this.listeners.delete(l);
  hasListener = (l: Listener<A>) => this.listeners.has(l);
  emit(...args: A) {
    return [...this.listeners].map((l) => l(...args));
  }
}

export function createFakeChrome() {
  let store: Record<string, unknown> = {};
  const storageChanged = new Event<[Record<string, chrome.storage.StorageChange>, string]>();
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const onAlarm = new Event<[chrome.alarms.Alarm]>();
  const onMessage = new Event<[unknown, chrome.runtime.MessageSender, (r: unknown) => void]>();
  const createdTabs: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

  function set(items: Record<string, unknown>) {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
      store[k] = clone(v);
    }
    storageChanged.emit(changes, "local");
  }

  const api = {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          if (keys == null) return clone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(items: Record<string, unknown>) {
          set(items);
        },
        async remove(keys: string | string[]) {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (k in store) {
              changes[k] = { oldValue: store[k] };
              delete store[k];
            }
          }
          storageChanged.emit(changes, "local");
        },
        async clear() {
          store = {};
        },
      },
      onChanged: storageChanged,
    },
    alarms: {
      async create(name: string, info: chrome.alarms.AlarmCreateInfo) {
        alarms.set(name, {
          name,
          scheduledTime: Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
          periodInMinutes: info.periodInMinutes,
        });
      },
      async get(name: string) {
        return alarms.get(name);
      },
      async getAll() {
        return [...alarms.values()];
      },
      async clear(name: string) {
        return alarms.delete(name);
      },
      async clearAll() {
        alarms.clear();
        return true;
      },
      onAlarm,
    },
    runtime: {
      id: "streamhunter-test-id",
      getURL: (p: string) => `chrome-extension://streamhunter-test-id/${p}`,
      onMessage,
      onInstalled: new Event<[chrome.runtime.InstalledDetails]>(),
      onStartup: new Event<[]>(),
      async sendMessage(message: unknown) {
        return new Promise((resolve) => {
          const sender = { id: "streamhunter-test-id" } as chrome.runtime.MessageSender;
          const results = onMessage.emit(message, sender, resolve);
          if (!results.some((r) => r === true)) resolve(undefined);
        });
      },
    },
    tabs: {
      async create({ url }: { url: string }) {
        createdTabs.push(url);
        return { id: createdTabs.length, url };
      },
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
    sidePanel: {
      setPanelBehavior: async () => undefined,
      open: async () => undefined,
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    notifications: {
      create: async (id: string, opts: Record<string, unknown>) => {
        notifications.push({ id, ...opts });
        return id;
      },
      clear: async () => true,
      onClicked: new Event<[string]>(),
    },
    permissions: { request: async () => true },
  };

  return {
    chrome: api as unknown as typeof chrome,
    /** Test helpers */
    internals: {
      get store() {
        return store;
      },
      alarms,
      createdTabs,
      notifications,
      fireAlarm: (name: string) => {
        const a = alarms.get(name);
        if (a) onAlarm.emit(a);
      },
      /** Simulates a worker restart: drops all registered listeners, keeps storage + alarms. */
      dropListeners: () => {
        onMessage.listeners.clear();
        onAlarm.listeners.clear();
        storageChanged.listeners.clear();
      },
    },
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;
