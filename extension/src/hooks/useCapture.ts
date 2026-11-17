import { useCallback, useEffect, useState } from "react";
import { sendRequest } from "@/services/runtime";
import { onStorageKeyChange } from "@/store/storage";
import { CAPTURE_KEY, INITIAL_CAPTURE_STATE, type CaptureState } from "@/types/capture";

/** Capture state (owned by the worker, read live from storage) plus start/stop/save. */
export function useCapture() {
  const [state, setState] = useState<CaptureState>(INITIAL_CAPTURE_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void chrome.storage.local.get(CAPTURE_KEY).then((r) => alive && setState({ ...INITIAL_CAPTURE_STATE, ...((r[CAPTURE_KEY] ?? {}) as Partial<CaptureState>) }));
    const off = onStorageKeyChange(CAPTURE_KEY, (v) => {
      if (v && typeof v === "object") setState({ ...INITIAL_CAPTURE_STATE, ...(v as Partial<CaptureState>) });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback(async (req: () => Promise<CaptureState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await req());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    error,
    start: useCallback((tabId: number, url: string) => run(() => sendRequest({ type: "capture/start", tabId, url })), [run]),
    stop: useCallback(() => run(() => sendRequest({ type: "capture/stop" })), [run]),
    saveLast: useCallback((seconds: number) => run(() => sendRequest({ type: "capture/save-last", seconds })), [run]),
  };
}
