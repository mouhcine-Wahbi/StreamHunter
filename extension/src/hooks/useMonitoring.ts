import { useCallback, useEffect, useState } from "react";
import { sendRequest } from "@/services/runtime";
import { getMonitoringState, onStorageKeyChange, STORAGE_KEYS } from "@/store/storage";
import { INITIAL_MONITORING_STATE, type MonitoringState } from "@/types/monitoring";

/**
 * Monitoring state is owned by the service worker and persisted in storage.
 * UI surfaces read it from storage (so they update live) and change it only
 * through runtime messages.
 */
export function useMonitoring() {
  const [state, setState] = useState<MonitoringState>(INITIAL_MONITORING_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getMonitoringState().then((s) => alive && setState(s));
    const off = onStorageKeyChange(STORAGE_KEYS.monitoring, (v) => {
      if (v && typeof v === "object") setState({ ...INITIAL_MONITORING_STATE, ...(v as Partial<MonitoringState>) });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback(async (type: "monitoring/start" | "monitoring/stop" | "monitoring/pause" | "monitoring/resume" | "monitoring/check-now") => {
    setBusy(true);
    setError(null);
    try {
      setState(await sendRequest({ type }));
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
    start: useCallback(() => run("monitoring/start"), [run]),
    stop: useCallback(() => run("monitoring/stop"), [run]),
    pause: useCallback(() => run("monitoring/pause"), [run]),
    resume: useCallback(() => run("monitoring/resume"), [run]),
    checkNow: useCallback(() => run("monitoring/check-now"), [run]),
  };
}
