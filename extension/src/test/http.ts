import { vi } from "vitest";

export type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | null;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Installs a fetch mock that answers via the given router; unmatched requests fail like a network error. */
export function mockFetch(route: Route) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = await route(url, init);
    if (!res) throw new TypeError("Failed to fetch");
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
