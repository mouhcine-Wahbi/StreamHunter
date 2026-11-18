import { useCallback, useEffect, useState } from "react";
import { sendRequest } from "@/services/runtime";
import { onStorageKeyChange } from "@/store/storage";
import { CAPTURES_KEY, INITIAL_CAPTURE_STATE, type CaptureState } from "@/types/capture";

interface Store {
  slots?: Record<string, Partial<CaptureState>>;
  note?: string | null;
  clips?: number;
}

/** All active recording slots (oldest first), the note left by the last stop, total clips. */
export function readCaptures(raw: unknown): { slots: CaptureState[]; note: string | null; clips: number } {
  const s = (raw ?? {}) as Store;
  const slots = Object.values(s.slots ?? {})
    .map((x) => ({ ...INITIAL_CAPTURE_STATE, ...x }))
    .filter((x) => x.status !== "off")
    .sort((a, b) => (a.armedAt ?? "").localeCompare(b.armedAt ?? ""));
  return { slots, note: s.note ?? null, clips: s.clips ?? 0 };
}

function useCapturesStore() {
  const [store, setStore] = useState(() => readCaptures(undefined));
  useEffect(() => {
    let alive = true;
    void chrome.storage.local
      .get(CAPTURES_KEY)
      .then((r) => alive && setStore(readCaptures(r[CAPTURES_KEY])))
      .catch(() => undefined);
    const off = onStorageKeyChange(CAPTURES_KEY, (v) => setStore(readCaptures(v)));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return store;
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (req: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await req();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/** Every recording slot plus per-slot controls (owned by the worker, read live from storage). */
export function useCaptures() {
  const store = useCapturesStore();
  const { busy, error, run } = useRunner();
  return {
    ...store,
    busy,
    error,
    pause: useCallback((tabId: number, paused: boolean) => run(() => sendRequest({ type: "capture/pause-slot", tabId, paused })), [run]),
    stop: useCallback((tabId: number) => run(() => sendRequest({ type: "capture/stop", tabId })), [run]),
    listen: useCallback((tabId: number, on: boolean) => run(() => sendRequest({ type: "capture/listen", tabId, on })), [run]),
    saveLast: useCallback((tabId: number, seconds: number) => run(() => sendRequest({ type: "capture/save-last", seconds, tabId })), [run]),
  };
}

/**
 * One slot: the one for `tabId` (the popup's tab), else the first recording slot, else an "off"
 * state with the last note. Plus start/arm/stop/save for it.
 */
export function useCapture(tabId?: number) {
  const store = useCapturesStore();
  const { busy, error, run } = useRunner();
  const found = tabId !== undefined ? store.slots.find((s) => s.tabId === tabId) : (store.slots.find((s) => s.recording) ?? store.slots[0]);
  const state: CaptureState = found ?? { ...INITIAL_CAPTURE_STATE, clips: store.clips, message: store.note };
  const slotId = found?.tabId ?? undefined;
  return {
    state,
    slots: store.slots,
    busy,
    error,
    start: useCallback((tab: number, url: string) => run(() => sendRequest({ type: "capture/start", tabId: tab, url })), [run]),
    arm: useCallback((tab: number) => run(() => sendRequest({ type: "capture/arm", tabId: tab })), [run]),
    stop: useCallback(() => run(() => sendRequest({ type: "capture/stop", ...(slotId !== undefined ? { tabId: slotId } : {}) })), [run, slotId]),
    saveLast: useCallback((seconds: number) => run(() => sendRequest({ type: "capture/save-last", seconds, ...(slotId !== undefined ? { tabId: slotId } : {}) })), [run, slotId]),
  };
}
