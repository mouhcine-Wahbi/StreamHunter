import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError } from "@/services/api-client";
import { LocalApi } from "@/local/local-api";

const shared = new LocalApi();

/** StreamHunter's local API (IndexedDB + Twitch/Kick/YouTube). One instance for the whole page. */
export function useApiClient(): ApiClient {
  return shared;
}

export interface QueryState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads `path` from the local API. Pass `null` to skip (e.g. until a search is submitted).
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
