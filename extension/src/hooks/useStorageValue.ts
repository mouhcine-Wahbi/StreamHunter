import { useEffect, useState } from "react";
import { onStorageKeyChange } from "@/store/storage";

/** A chrome.storage.local value, kept live. */
export function useStorageValue<T>(key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void chrome.storage.local
      .get(key)
      .then((r) => alive && setValue(r[key] as T | undefined))
      .catch(() => undefined);
    const off = onStorageKeyChange(key, (v) => setValue(v as T | undefined));
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return value;
}
