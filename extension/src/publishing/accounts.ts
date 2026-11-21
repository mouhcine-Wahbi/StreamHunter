/**
 * Publishing accounts (3.0 phase 7). You connect your own accounts with your own developer apps;
 * nothing is shared with StreamHunter's authors and no secret is ever stored in the extension.
 *
 *   YouTube: Google OAuth 2.0 for client-side apps (implicit grant) with your OAuth client ID
 *            (type "Web application", redirect https://<extension-id>.chromiumapp.org/). No secret.
 *            Tokens last about an hour and are renewed silently while Google allows it.
 *   X:       OAuth 2.0 Authorization Code with PKCE as a public client (type "Native App" or
 *            "Single page App"), scopes tweet.read tweet.write users.read media.write offline.access.
 *            No secret; refresh tokens rotate.
 *   TikTok:  Login Kit for Web, authorization code. TikTok requires the client secret to stay on a
 *            server, so the code is exchanged by a token server YOU run (see docs/PUBLISHING.md for
 *            its two-request contract). StreamHunter never sees the secret.
 *
 * Endpoints are the ones in each platform's documentation (checked 2026-11-21).
 */
import type { Destination } from "@/local/rights";

export const ACCOUNTS_KEY = "sh.publishAccounts";

export interface AppConfig {
  /** YouTube: Google OAuth client ID. X: OAuth 2.0 client ID. TikTok: client key. */
  clientId: string;
  /** TikTok only: your token server (https). */
  tokenServer?: string;
}

export interface Token {
  access: string;
  refresh: string | null;
  /** ms since epoch */
  expiresAt: number;
  refreshExpiresAt: number | null;
  scope: string;
}

export interface Profile {
  id: string;
  name: string;
  /** Handle used to build post links (X username, TikTok username). */
  handle: string | null;
}

export interface StoredAccount {
  config: AppConfig | null;
  token: Token | null;
  profile: Profile | null;
  connected_at: string | null;
  /** Why the last renewal failed (you need to connect again). */
  problem: string | null;
}

/** What pages may see: never the tokens. */
export interface AccountView {
  destination: Destination;
  configured: boolean;
  clientId: string | null;
  tokenServer: string | null;
  connected: boolean;
  name: string | null;
  handle: string | null;
  connected_at: string | null;
  problem: string | null;
}

export class AccountError extends Error {}

const EMPTY: StoredAccount = { config: null, token: null, profile: null, connected_at: null, problem: null };

export const ENDPOINTS = {
  youtube: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    channels: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
  },
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    me: "https://api.x.com/2/users/me",
    scope: "tweet.read tweet.write users.read media.write offline.access",
  },
  tiktok: {
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    creatorInfo: "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    scope: "user.info.basic,video.publish,video.list",
  },
} as const;

/** Hosts StreamHunter must be allowed to contact for each destination (asked for when you connect). */
export function originsFor(dest: Destination, config?: AppConfig | null): string[] {
  if (dest === "youtube") return ["https://www.googleapis.com/*"];
  if (dest === "x") return ["https://api.x.com/*"];
  const o = ["https://open.tiktokapis.com/*", "https://*.tiktokapis.com/*"];
  if (config?.tokenServer) {
    try {
      const u = new URL(config.tokenServer);
      o.push(`${u.protocol}//${u.hostname}/*`);
    } catch {
      /* validated elsewhere */
    }
  }
  return o;
}

// --- storage -----------------------------------------------------------------------------------

async function readAll(): Promise<Record<Destination, StoredAccount>> {
  const raw = ((await chrome.storage.local.get(ACCOUNTS_KEY))[ACCOUNTS_KEY] ?? {}) as Partial<Record<Destination, StoredAccount>>;
  return { youtube: { ...EMPTY, ...raw.youtube }, tiktok: { ...EMPTY, ...raw.tiktok }, x: { ...EMPTY, ...raw.x } };
}

async function write(dest: Destination, a: StoredAccount): Promise<void> {
  const all = await readAll();
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: { ...all, [dest]: a } });
}

export async function getAccount(dest: Destination): Promise<StoredAccount> {
  return (await readAll())[dest];
}

export function viewOf(dest: Destination, a: StoredAccount): AccountView {
  return {
    destination: dest,
    configured: Boolean(a.config?.clientId),
    clientId: a.config?.clientId ?? null,
    tokenServer: a.config?.tokenServer ?? null,
    connected: Boolean(a.token && a.profile),
    name: a.profile?.name ?? null,
    handle: a.profile?.handle ?? null,
    connected_at: a.connected_at,
    problem: a.problem,
  };
}

export async function listAccounts(): Promise<AccountView[]> {
  const all = await readAll();
  return (["youtube", "tiktok", "x"] as const).map((d) => viewOf(d, all[d]));
}

/** Your developer app for a destination. Changing it disconnects the account. */
export async function setAppConfig(dest: Destination, config: AppConfig | null): Promise<AccountView> {
  if (config) {
    const clientId = config.clientId.trim();
    if (!/^[\w.\-~:]{6,200}$/.test(clientId)) throw new AccountError("That doesn't look like a client ID.");
    let tokenServer: string | undefined;
    if (dest === "tiktok") {
      tokenServer = (config.tokenServer ?? "").trim();
      let u: URL;
      try {
        u = new URL(tokenServer);
      } catch {
        throw new AccountError("Enter your token server's URL.");
      }
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new AccountError("The token server must use https (or run on localhost).");
    }
    const cur = await getAccount(dest);
    const same = cur.config?.clientId === clientId && cur.config?.tokenServer === tokenServer;
    const next: StoredAccount = same ? { ...cur, config: { clientId, tokenServer } } : { ...EMPTY, config: { clientId, ...(tokenServer ? { tokenServer } : {}) } };
    await write(dest, next);
    return viewOf(dest, next);
  }
  await write(dest, { ...EMPTY });
  return viewOf(dest, EMPTY);
}

export async function disconnect(dest: Destination): Promise<AccountView> {
  const cur = await getAccount(dest);
  const next = { ...cur, token: null, profile: null, connected_at: null, problem: null };
  await write(dest, next);
  return viewOf(dest, next);
}

// --- OAuth ---------------------------------------------------------------------------------------

export interface AuthDeps {
  /** chrome.identity.launchWebAuthFlow; returns the final redirect URL. */
  launch?: (url: string, interactive: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export function redirectUri(): string {
  return chrome.identity?.getRedirectURL?.() ?? `https://${chrome.runtime.id}.chromiumapp.org/`;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (deps: AuthDeps, n: number) => (deps.random ?? ((k) => crypto.getRandomValues(new Uint8Array(k))))(n);

export async function pkce(deps: AuthDeps = {}): Promise<{ verifier: string; s256: string; s256hex: string }> {
  const verifier = b64url(rand(deps, 48)); // 64 characters from the unreserved set
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, s256: b64url(digest), s256hex: hex(digest) };
}

const launchDefault = async (url: string, interactive: boolean) => {
  const r = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!r) throw new AccountError("Sign-in was cancelled.");
  return r;
};

async function json(r: Response, what: string): Promise<Record<string, unknown>> {
  const text = await r.text();
  let j: Record<string, unknown> = {};
  try {
    j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* fall through */
  }
  if (!r.ok) {
    const e = j as { error?: unknown; error_description?: unknown; message?: unknown; detail?: unknown };
    const msg = [e.error_description, typeof e.error === "string" ? e.error : (e.error as { message?: string })?.message, e.message, e.detail].find((x) => typeof x === "string" && x);
    throw new AccountError(`${what} failed (HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 160)}` : ""}).`);
  }
  return j;
}

function tokenFrom(j: Record<string, unknown>, now: number, prevRefresh: string | null = null): Token {
  const access = j.access_token;
  if (typeof access !== "string" || !access) throw new AccountError("The platform returned no access token.");
  const exp = Number(j.expires_in ?? 3600);
  const rexp = j.refresh_expires_in != null ? Number(j.refresh_expires_in) : null;
  return {
    access,
    refresh: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : prevRefresh,
    expiresAt: now + Math.max(60, exp) * 1000,
    refreshExpiresAt: rexp ? now + rexp * 1000 : null,
    scope: typeof j.scope === "string" ? j.scope : "",
  };
}

function paramsOf(redirected: string, where: "query" | "fragment"): URLSearchParams {
  const u = new URL(redirected);
  return new URLSearchParams(where === "query" ? u.search : u.hash.replace(/^#/, ""));
}

function checkState(p: URLSearchParams, state: string) {
  const err = p.get("error");
  if (err) throw new AccountError(err === "access_denied" ? "You declined access." : `Sign-in failed: ${p.get("error_description") ?? err}`);
  if (p.get("state") !== state) throw new AccountError("Sign-in response didn't match (state). Try again.");
}

async function youtubeToken(cfg: AppConfig, interactive: boolean, deps: AuthDeps): Promise<Token> {
  const state = b64url(rand(deps, 16));
  const u = new URL(ENDPOINTS.youtube.authorize);
  u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: "token", scope: ENDPOINTS.youtube.scope, state, include_granted_scopes: "true", ...(interactive ? {} : { prompt: "none" }) }).toString();
  const p = paramsOf(await (deps.launch ?? launchDefault)(u.toString(), interactive), "fragment");
  checkState(p, state);
  return tokenFrom(Object.fromEntries(p), (deps.now ?? Date.now)());
}

/** Signs in with your app and stores the account. Run from a page (it opens a sign-in window). */
export async function connect(dest: Destination, deps: AuthDeps = {}): Promise<AccountView> {
  const cur = await getAccount(dest);
  const cfg = cur.config;
  if (!cfg?.clientId) throw new AccountError("Enter your app's client ID first.");
  const f = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? Date.now)();
  let token: Token;
  let profile: Profile;
  if (dest === "youtube") {
    token = await youtubeToken(cfg, true, deps);
    const j = await json(await f(ENDPOINTS.youtube.channels, { headers: { authorization: `Bearer ${token.access}` } }), "Reading your YouTube channel");
    const ch = (j.items as { id: string; snippet?: { title?: string; customUrl?: string } }[] | undefined)?.[0];
    if (!ch) throw new AccountError("This Google account has no YouTube channel.");
    profile = { id: ch.id, name: ch.snippet?.title ?? ch.id, handle: ch.snippet?.customUrl ?? null };
  } else if (dest === "x") {
    const { verifier, s256 } = await pkce(deps);
    const state = b64url(rand(deps, 16));
    const u = new URL(ENDPOINTS.x.authorize);
    u.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri(), scope: ENDPOINTS.x.scope, state, code_challenge: s256, code_challenge_method: "S256" }).toString();
    const p = paramsOf(await (deps.launch ?? launchDefault)(u.toString(), true), "query");
    checkState(p, state);
    const body = new URLSearchParams({ code: p.get("code") ?? "", grant_type: "authorization_code", client_id: cfg.clientId, redirect_uri: redirectUri(), code_verifier: verifier });
    token = tokenFrom(await json(await f(ENDPOINTS.x.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), "X sign-in"), now);
    const me = (await json(await f(ENDPOINTS.x.me, { headers: { authorization: `Bearer ${token.access}` } }), "Reading your X account")).data as { id: string; name?: string; username?: string } | undefined;
    if (!me?.id) throw new AccountError("X returned no account.");
    profile = { id: me.id, name: me.name ?? me.username ?? me.id, handle: me.username ?? null };
  } else {
    const { verifier, s256hex } = await pkce(deps);
    const state = b64url(rand(deps, 16));
    const u = new URL(ENDPOINTS.tiktok.authorize);
    // TikTok's web guide uses the hex SHA-256 of the verifier as the challenge.
    u.search = new URLSearchParams({ client_key: cfg.clientId, response_type: "code", scope: ENDPOINTS.tiktok.scope, redirect_uri: redirectUri(), state, code_challenge: s256hex, code_challenge_method: "S256" }).toString();
    const p = paramsOf(await (deps.launch ?? launchDefault)(u.toString(), true), "query");
    checkState(p, state);
    token = tokenFrom(
      await json(await f(cfg.tokenServer!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_key: cfg.clientId, code: p.get("code") ?? "", redirect_uri: redirectUri(), code_verifier: verifier }) }), "Your TikTok token server"),
      now,
    );
    const info = await json(await f(ENDPOINTS.tiktok.creatorInfo, { method: "POST", headers: { authorization: `Bearer ${token.access}`, "content-type": "application/json; charset=UTF-8" } }), "Reading your TikTok account");
    const d = info.data as { creator_username?: string; creator_nickname?: string } | undefined;
    const errCode = (info.error as { code?: string; message?: string } | undefined)?.code;
    if (errCode && errCode !== "ok") throw new AccountError(`TikTok: ${(info.error as { message?: string }).message || errCode}`);
    profile = { id: d?.creator_username ?? "tiktok", name: d?.creator_nickname || d?.creator_username || "TikTok account", handle: d?.creator_username ?? null };
  }
  const next: StoredAccount = { config: cfg, token, profile, connected_at: new Date(now).toISOString(), problem: null };
  await write(dest, next);
  return viewOf(dest, next);
}

/** A valid access token, renewed when it's about to expire. Throws AccountError when you must connect again. */
export async function accessToken(dest: Destination, deps: AuthDeps = {}): Promise<{ token: string; profile: Profile }> {
  const a = await getAccount(dest);
  if (!a.config?.clientId || !a.token || !a.profile) throw new AccountError(`Connect your ${dest === "x" ? "X" : dest === "tiktok" ? "TikTok" : "YouTube"} account first (Settings → Publishing).`);
  const now = (deps.now ?? Date.now)();
  if (a.token.expiresAt - now > 60_000) return { token: a.token.access, profile: a.profile };
  const f = deps.fetchImpl ?? fetch;
  try {
    let token: Token;
    if (dest === "youtube") token = await youtubeToken(a.config, false, deps);
    else if (!a.token.refresh || (a.token.refreshExpiresAt && a.token.refreshExpiresAt < now)) throw new AccountError("The sign-in expired.");
    else if (dest === "x") {
      const body = new URLSearchParams({ refresh_token: a.token.refresh, grant_type: "refresh_token", client_id: a.config.clientId });
      token = tokenFrom(await json(await f(ENDPOINTS.x.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), "Renewing X sign-in"), now, a.token.refresh);
    } else {
      const r = await f(a.config.tokenServer!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", client_key: a.config.clientId, refresh_token: a.token.refresh }) });
      token = tokenFrom(await json(r, "Renewing TikTok sign-in (your token server)"), now, a.token.refresh);
    }
    await write(dest, { ...a, token, problem: null });
    return { token: token.access, profile: a.profile };
  } catch (e) {
    const problem = `${e instanceof Error ? e.message : "Renewal failed"} Connect again in Settings → Publishing.`;
    await write(dest, { ...a, problem });
    throw new AccountError(problem);
  }
}
