import { useCallback, useEffect, useState } from "react";
import { sendRequest } from "@/services/runtime";
import { getTabAudioState, onStorageKeyChange, STORAGE_KEYS } from "@/store/storage";
import { INITIAL_TAB_AUDIO_STATE, type TabAudioState } from "@/types/tab-audio";

/** Tab-audio state (owned by the worker, read live from storage) plus start/stop. */
export function useTabAudio() {
  const [state, setState] = useState<TabAudioState>(INITIAL_TAB_AUDIO_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getTabAudioState().then((s) => alive && setState(s));
    const off = onStorageKeyChange(STORAGE_KEYS.tabAudio, (v) => {
      if (v && typeof v === "object") setState({ ...INITIAL_TAB_AUDIO_STATE, ...(v as Partial<TabAudioState>) });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback(async (req: () => Promise<TabAudioState>) => {
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
    start: useCallback(
      (tabId: number, url: string, sounds = false) => run(() => sendRequest({ type: "tab-audio/start", tabId, url, sounds })),
      [run],
    ),
    stop: useCallback(() => run(() => sendRequest({ type: "tab-audio/stop" })), [run]),
  };
}
