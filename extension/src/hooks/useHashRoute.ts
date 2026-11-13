import { useCallback, useEffect, useState } from "react";

function current(valid: readonly string[], fallback: string): string {
  const raw = window.location.hash.replace(/^#/, "") || fallback;
  return valid.includes(raw) ? raw : fallback;
}

/** Tiny hash router: extension pages are static files, so hash routing is the robust choice. */
export function useHashRoute<T extends string>(valid: readonly T[], fallback: T) {
  const [route, setRoute] = useState<T>(() => current(valid, fallback) as T);

  useEffect(() => {
    const onChange = () => setRoute(current(valid, fallback) as T);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [valid, fallback]);

  const navigate = useCallback((to: T) => {
    if (window.location.hash !== `#${to}`) window.location.hash = to;
    setRoute(to);
  }, []);

  return { route, navigate };
}
