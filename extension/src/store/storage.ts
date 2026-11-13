import { INITIAL_MONITORING_STATE, type MonitoringState } from "@/types/monitoring";
import type { DeepPartial, Settings } from "@/types/settings";
import { mergeSettings, sanitizeSettings } from "@/utils/settings";

/**
 * Typed access to chrome.storage.local. Everything the service worker needs to
 * survive suspension lives here — never in module-level variables.
 */
export const STORAGE_KEYS = {
  settings: "sh.settings",
  monitoring: "sh.monitoring",
  authToken: "sh.authToken",
} as const;

type Key = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

async function read(key: Key): Promise<unknown> {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

export async function getSettings(): Promise<Settings> {
  return sanitizeSettings(await read(STORAGE_KEYS.settings));
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const clean = sanitizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: clean });
  return clean;
}

export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  return saveSettings(mergeSettings(await getSettings(), patch));
}

export async function getMonitoringState(): Promise<MonitoringState> {
  const raw = await read(STORAGE_KEYS.monitoring);
  if (typeof raw !== "object" || raw === null) return { ...INITIAL_MONITORING_STATE };
  return { ...INITIAL_MONITORING_STATE, ...(raw as Partial<MonitoringState>) };
}

export async function setMonitoringState(state: MonitoringState): Promise<MonitoringState> {
  await chrome.storage.local.set({ [STORAGE_KEYS.monitoring]: state });
  return state;
}

export async function patchMonitoringState(patch: Partial<MonitoringState>): Promise<MonitoringState> {
  return setMonitoringState({ ...(await getMonitoringState()), ...patch });
}

/** StreamHunter session token (never a platform OAuth token). */
export async function getAuthToken(): Promise<string | null> {
  const v = await read(STORAGE_KEYS.authToken);
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function setAuthToken(token: string | null): Promise<void> {
  if (token) await chrome.storage.local.set({ [STORAGE_KEYS.authToken]: token });
  else await chrome.storage.local.remove(STORAGE_KEYS.authToken);
}

/** Subscribes to changes of one key in local storage. Returns an unsubscribe function. */
export function onStorageKeyChange(key: Key, cb: (newValue: unknown) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && key in changes) cb(changes[key]?.newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
