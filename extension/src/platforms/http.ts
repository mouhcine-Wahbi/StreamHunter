import type { Platform } from "@/types/api";

export type PlatformErrorKind = "not_configured" | "unauthorized" | "rate_limited" | "http" | "network";

/** A failed call to Twitch or Kick, with a message that can be shown as is. */
export class PlatformError extends Error {
  constructor(
    readonly platform: Platform,
    readonly kind: PlatformErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Seconds to wait before the next call, when the platform said so (429). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

const LABEL: Record<Platform, string> = { twitch: "Twitch", kick: "Kick", youtube: "YouTube" };

export interface HttpDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** GET/POST JSON with a timeout and readable errors. Never logs or echoes credentials. */
export async function requestJson<T>(
  platform: Platform,
  url: string,
  init: RequestInit & HttpDeps = {},
): Promise<T> {
  const { fetchImpl = (...a: Parameters<typeof fetch>) => globalThis.fetch(...a), timeoutMs = 10_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response | null | undefined;
  try {
    res = await fetchImpl(url, { ...rest, signal: ctrl.signal });
  } catch {
    throw new PlatformError(platform, "network", `${LABEL[platform]} could not be reached. Check the internet connection.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res) throw new PlatformError(platform, "network", `${LABEL[platform]} could not be reached. Check the internet connection.`);
  if (res.status === 429) {
    const ra = Number(res.headers.get("Retry-After"));
    const reset = Number(res.headers.get("Ratelimit-Reset")); // Twitch: epoch seconds
    const wait = Number.isFinite(ra) && ra > 0 ? ra : Number.isFinite(reset) && reset > 0 ? Math.max(1, reset - Date.now() / 1000) : 60;
    throw new PlatformError(platform, "rate_limited", `${LABEL[platform]} asked StreamHunter to slow down.`, 429, Math.ceil(wait));
  }
  if (res.status === 401 || res.status === 403) {
    throw new PlatformError(platform, "unauthorized", `${LABEL[platform]} refused the credentials (HTTP ${res.status}).`, res.status);
  }
  if (!res.ok) {
    throw new PlatformError(platform, "http", `${LABEL[platform]} answered HTTP ${res.status}.`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new PlatformError(platform, "http", `${LABEL[platform]} sent a response StreamHunter could not read.`, res.status);
  }
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
