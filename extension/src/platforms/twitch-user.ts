import { getCredentials } from "./credentials";
import { PlatformError, requestJson } from "./http";

/**
 * "Sign in with Twitch": a user access token with `user:read:chat`, which Twitch requires to read
 * chat over EventSub. Implicit grant through chrome.identity (no secret, no server). The token is
 * kept in chrome.storage.local; it is never sent anywhere but Twitch.
 *
 * The editor's Twitch app must list this extension's redirect URL (shown in Settings).
 */
export const TWITCH_USER_KEY = "sh.twitchUser";
export const CHAT_SCOPE = "user:read:chat";
/** Optional: create Twitch clips (Settings → Clips → Also create a Twitch clip). */
export const CLIPS_SCOPE = "clips:edit";

export interface TwitchUser {
  token: string;
  userId: string;
  login: string;
  scopes: string[];
  /** Epoch ms, or null when Twitch didn't say. */
  expiresAt: number | null;
}

export function redirectUrl(): string {
  return chrome.identity?.getRedirectURL?.() ?? `https://${chrome.runtime.id}.chromiumapp.org/`;
}

export async function getTwitchUser(now = Date.now()): Promise<TwitchUser | null> {
  const u = (await chrome.storage.local.get(TWITCH_USER_KEY))[TWITCH_USER_KEY] as TwitchUser | undefined;
  if (!u?.token) return null;
  if (u.expiresAt !== null && u.expiresAt < now) return null;
  return u;
}

export async function validateToken(token: string): Promise<Omit<TwitchUser, "token">> {
  const v = await requestJson<{ user_id?: string; login?: string; scopes?: string[]; expires_in?: number }>(
    "twitch",
    "https://id.twitch.tv/oauth2/validate",
    { headers: { Authorization: `OAuth ${token}` } },
  );
  if (!v.user_id || !v.login) throw new PlatformError("twitch", "unauthorized", "Twitch didn't accept the sign-in.");
  return { userId: v.user_id, login: v.login, scopes: v.scopes ?? [], expiresAt: v.expires_in ? Date.now() + v.expires_in * 1000 : null };
}

export async function signInWithTwitch(opts: { clips?: boolean } = {}): Promise<TwitchUser> {
  const creds = (await getCredentials()).twitch;
  if (!creds) throw new PlatformError("twitch", "not_configured", "Save your Twitch app's client ID first.");
  const state = crypto.randomUUID();
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUrl(),
    response_type: "token",
    scope: opts.clips ? `${CHAT_SCOPE} ${CLIPS_SCOPE}` : CHAT_SCOPE,
    state,
    force_verify: "true",
  }).toString();
  const back = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  if (!back) throw new Error("Twitch sign-in was cancelled.");
  const params = new URLSearchParams(new URL(back).hash.slice(1));
  if (params.get("error")) throw new Error(`Twitch sign-in failed: ${params.get("error_description") ?? params.get("error")}`);
  if (params.get("state") !== state) throw new Error("Twitch sign-in answer didn't match the request.");
  const token = params.get("access_token");
  if (!token) throw new Error("Twitch sign-in returned no token.");
  const user: TwitchUser = { token, ...(await validateToken(token)) };
  if (!user.scopes.includes(CHAT_SCOPE)) throw new Error("Twitch didn't grant permission to read chat.");
  await chrome.storage.local.set({ [TWITCH_USER_KEY]: user });
  return user;
}

export async function signOutOfTwitch(): Promise<void> {
  const u = (await chrome.storage.local.get(TWITCH_USER_KEY))[TWITCH_USER_KEY] as TwitchUser | undefined;
  await chrome.storage.local.remove(TWITCH_USER_KEY);
  const creds = (await getCredentials()).twitch;
  if (u?.token && creds) {
    await fetch("https://id.twitch.tv/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: creds.clientId, token: u.token }).toString(),
    }).catch(() => undefined);
  }
}
