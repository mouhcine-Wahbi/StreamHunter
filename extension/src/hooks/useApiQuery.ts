import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "@/services/api-client";
import { getAuthToken } from "@/store/storage";
import { useSettings } from "./useSettings";

export function useApiClient(): ApiClient {
  const { settings } = useSettings();
  return useMemo(() => new ApiClient({ baseUrl: settings.backendUrl, getToken: getAuthToken }), [settings.backendUrl]);
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
