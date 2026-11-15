import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "@/services/api-client";
import { getAuthToken, onStorageKeyChange, STORAGE_KEYS } from "@/store/storage";
import { useSettings } from "./useSettings";

/** Increments whenever the session token changes (sign in / sign out in any extension page). */
function useAuthVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onStorageKeyChange(STORAGE_KEYS.authToken, () => setVersion((v) => v + 1)), []);
  return version;
}

/** A client for the configured backend. A new instance after sign-in/out makes queries refetch. */
export function useApiClient(): ApiClient {
  const { settings } = useSettings();
  const authVersion = useAuthVersion();
  return useMemo(
    () => new ApiClient({ baseUrl: settings.backendUrl, getToken: getAuthToken }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.backendUrl, authVersion],
  );
}

export interface QueryState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches `path` from the backend. Pass `null` to skip (e.g. until a search is submitted).
 * Stale responses from earlier paths are discarded.
 */
export function useApiQuery<T>(path: string | null): QueryState<T> {
  const client = useApiClient();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    client
      .get<T>(path)
      .then((d) => mine === seq.current && setData(d))
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setData(null);
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => mine === seq.current && setLoading(false));
  }, [client, path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
