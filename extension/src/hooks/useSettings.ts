import { useCallback, useEffect, useState } from "react";
import { getSettings, onStorageKeyChange, saveSettings, STORAGE_KEYS, updateSettings } from "@/store/storage";
import { DEFAULT_SETTINGS, type DeepPartial, type Settings } from "@/types/settings";
import { sanitizeSettings } from "@/utils/settings";

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getSettings().then((s) => {
      if (alive) {
        setSettings(s);
        setLoaded(true);
      }
    });
    const off = onStorageKeyChange(STORAGE_KEYS.settings, (v) => setSettings(sanitizeSettings(v)));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const update = useCallback(async (patch: DeepPartial<Settings>) => {
    const next = await updateSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const reset = useCallback(async () => {
    const next = await saveSettings(DEFAULT_SETTINGS);
    setSettings(next);
    return next;
  }, []);

  return { settings, loaded, update, reset };
}
