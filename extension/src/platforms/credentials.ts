import type { Platform } from "@/types/api";

/**
 * The editor's own Twitch / Kick developer-app credentials, entered in Settings.
 *
 * StreamHunter has no server, so it can't hold a shared app secret. Each editor registers a free
 * app (dev.twitch.tv/console, kick.com/settings/developer) and pastes its client ID and secret.
 * They are kept in chrome.storage.local on this computer only and sent only to that platform's
 * own token endpoint. App access tokens are cached next to them.
 */
export interface AppCredentials {
  clientId: string;
  /**
   * Empty for Twitch in "no secret" mode: API calls then use the editor's Sign in with Twitch
   * token instead of an app token, so no secret is stored at all.
   */
  clientSecret: string;
}

/** YouTube Data API: an API key from the editor's own Google Cloud project (public data only). */
export interface YouTubeCredentials {
  apiKey: string;
}

/** Platforms that use an app (client ID + secret). */
export type AppPlatform = "twitch" | "kick";

export interface PlatformCredentials {
  twitch: AppCredentials | null;
  kick: AppCredentials | null;
  youtube: YouTubeCredentials | null;
}

interface CachedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

export const CREDENTIALS_KEY = "sh.platformCredentials";
const TOKENS_KEY = "sh.appTokens";

function valid(c: unknown, secretOptional = false): AppCredentials | null {
  const v = c as Partial<AppCredentials> | null;
  const id = typeof v?.clientId === "string" ? v.clientId.trim() : "";
  const secret = typeof v?.clientSecret === "string" ? v.clientSecret.trim() : "";
  return id && (secret || secretOptional) ? { clientId: id, clientSecret: secret } : null;
}

function validKey(c: unknown): YouTubeCredentials | null {
  const k = (c as Partial<YouTubeCredentials> | null)?.apiKey;
  return typeof k === "string" && /^[\w-]{20,60}$/.test(k.trim()) ? { apiKey: k.trim() } : null;
}

export async function getCredentials(): Promise<PlatformCredentials> {
  const raw = ((await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] ?? {}) as Record<string, unknown>;
  return { twitch: valid(raw.twitch, true), kick: valid(raw.kick), youtube: validKey(raw.youtube) };
}

export async function setCredentials(platform: Platform, creds: AppCredentials | YouTubeCredentials | null): Promise<PlatformCredentials> {
  const current = await getCredentials();
  const clean = !creds ? null : platform === "youtube" ? validKey(creds) : valid(creds, platform === "twitch");
  const next = { ...current, [platform]: clean };
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: next });
  await clearToken(platform); // a token from the old app must not be reused
  return next;
}

async function tokens(): Promise<Partial<Record<Platform, CachedToken>>> {
  return ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Partial<Record<Platform, CachedToken>>;
}

export async function getCachedToken(platform: Platform, now = Date.now()): Promise<string | null> {
  const t = (await tokens())[platform];
  return t && typeof t.token === "string" && t.expiresAt - 60_000 > now ? t.token : null;
}

export async function setCachedToken(platform: Platform, token: string, expiresInSec: number | null, now = Date.now()): Promise<void> {
  const all = await tokens();
  // Without an expiry, assume one hour and refresh then (a 401 also forces a refresh).
  all[platform] = { token, expiresAt: now + (expiresInSec && expiresInSec > 0 ? expiresInSec : 3600) * 1000 };
  await chrome.storage.local.set({ [TOKENS_KEY]: all });
}

export async function clearToken(platform: Platform): Promise<void> {
  const all = await tokens();
  delete all[platform];
  await chrome.storage.local.set({ [TOKENS_KEY]: all });
}
