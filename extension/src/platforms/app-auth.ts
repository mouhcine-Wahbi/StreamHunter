import type { Platform } from "@/types/api";
import { clearToken, getCachedToken, getCredentials, setCachedToken, type AppCredentials } from "./credentials";
import { PlatformError, requestJson, type HttpDeps } from "./http";

const TOKEN_URL: Record<Platform, string> = {
  twitch: "https://id.twitch.tv/oauth2/token",
  kick: "https://id.kick.com/oauth/token",
};

const SETUP: Record<Platform, string> = {
  twitch: "Add your Twitch app's client ID and secret in Settings → Platforms (create one at dev.twitch.tv/console).",
  kick: "Add your Kick app's client ID and secret in Settings → Platforms (create one at kick.com/settings/developer).",
};

/**
 * App access tokens (OAuth client credentials) for the editor's own developer app, cached in
 * storage. `call` runs a request with the token and, on 401, fetches a fresh token once and retries.
 */
export function appAuth(platform: Platform, http: HttpDeps = {}) {
  async function credentials(): Promise<AppCredentials> {
    const c = (await getCredentials())[platform];
    if (!c) throw new PlatformError(platform, "not_configured", SETUP[platform]);
    return c;
  }

  async function fetchToken(c: AppCredentials): Promise<string> {
    const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "client_credentials" });
    let res: { access_token?: unknown; expires_in?: unknown };
    try {
      res = await requestJson(platform, TOKEN_URL[platform], {
        ...http,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
    } catch (e) {
      if (e instanceof PlatformError && (e.kind === "unauthorized" || e.status === 400))
        throw new PlatformError(platform, "unauthorized", `${platform === "twitch" ? "Twitch" : "Kick"} rejected the client ID or secret. Check them in Settings → Platforms.`, e.status);
      throw e;
    }
    if (typeof res.access_token !== "string" || !res.access_token)
      throw new PlatformError(platform, "http", "The token response had no access token.");
    await setCachedToken(platform, res.access_token, typeof res.expires_in === "number" ? res.expires_in : null);
    return res.access_token;
  }

  async function call<T>(run: (token: string, clientId: string) => Promise<T>): Promise<T> {
    const c = await credentials();
    const token = (await getCachedToken(platform)) ?? (await fetchToken(c));
    try {
      return await run(token, c.clientId);
    } catch (e) {
      if (!(e instanceof PlatformError && e.kind === "unauthorized")) throw e;
      await clearToken(platform); // expired or revoked: one fresh token, one retry
      return run(await fetchToken(c), c.clientId);
    }
  }

  return { call, configured: async () => (await getCredentials())[platform] !== null };
}
