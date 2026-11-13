import { useCallback, useState } from "react";

/** Wraps an async action with pending/error state for buttons. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  return { run, pending, error };
}
