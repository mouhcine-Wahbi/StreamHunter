import { ApiClient, ApiError, type ApiClientOptions } from "@/services/api-client";
import { getCredentials } from "@/platforms/credentials";
import { PlatformError } from "@/platforms/http";
import type { ChannelInfo } from "@/platforms/types";
import type { Page, Platform, Streamer, StreamerSearchResult } from "@/types/api";
import { listSessions, syncSessions } from "./sessions";
import {
  addStreamer,
  LocalError,
  listStreamers,
  platformClients,
  refreshStatuses,
  removeStreamer,
  resolveChannel,
  updateStreamer,
  type Clients,
} from "./streamers";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => Promise<unknown>;

function page<T>(items: T[], q: URLSearchParams): Page<T> {
  const limit = Math.max(1, Math.min(500, Number(q.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function platformParam(v: string | null): Platform {
  if (v === "twitch" || v === "kick") return v;
  throw new LocalError("invalid_platform", "Choose Twitch or Kick", 422);
}

function searchResult(c: ChannelInfo): StreamerSearchResult & { viewer_count: number | null } {
  return {
    platform: c.platform,
    platform_user_id: c.platform_user_id,
    username: c.username,
    display_name: c.display_name,
    profile_image_url: c.profile_image_url,
    is_live: c.is_live,
    current_title: c.current_title,
    current_category: c.current_category,
    viewer_count: c.viewer_count,
  };
}

/**
 * StreamHunter's API, answered inside the extension (IndexedDB + the platform APIs) instead of by
 * a server. It keeps the `/api/v1/...` paths and response shapes the pages already use.
 *
 * During the migration, paths that aren't local yet still go to the old backend (`super.request`).
 */
export class LocalApi extends ApiClient {
  private readonly routes: [Method, RegExp, Handler][];

  constructor(
    opts: ApiClientOptions,
    private readonly clients: () => Clients = platformClients,
  ) {
    super(opts);
    this.routes = [
      ["GET", /^\/api\/v1\/streamers\/search$/, (_m, q) => this.search(q)],
      ["GET", /^\/api\/v1\/discover\/live$/, (_m, q) => this.discoverLive(q)],
      ["GET", /^\/api\/v1\/streamers$/, async (_m, q) => page(await listStreamers(), q)],
      ["POST", /^\/api\/v1\/streamers$/, (_m, _q, b) => this.add(b)],
      ["PATCH", /^\/api\/v1\/streamers\/(\d+)$/, (m, _q, b) => updateStreamer(Number(m[1]), (b ?? {}) as Partial<Streamer>)],
      ["DELETE", /^\/api\/v1\/streamers\/(\d+)$/, async (m) => void (await removeStreamer(Number(m[1])))],
      ["GET", /^\/api\/v1\/streams\/live$/, async (_m, q) => page((await listStreamers()).filter((s) => s.is_live === true), q)],
      ["POST", /^\/api\/v1\/streams\/refresh$/, async () => {
        const r = await refreshStatuses(this.clients());
        await syncSessions(new Set(r.checked_ids), new Date());
        return { checked: r.checked, live: r.live, skipped_recent: r.skipped_recent, unavailable: r.unavailable };
      }],
      ["GET", /^\/api\/v1\/platforms\/capabilities$/, () => this.capabilities()],
      ["GET", /^\/api\/v1\/monitoring$/, async (_m, q) => page(await listSessions(), q)],
    ];
  }

  override async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, "http://local");
    for (const [m, re, handler] of this.routes) {
      const match = m === method ? url.pathname.match(re) : null;
      if (!match) continue;
      try {
        return (await handler(match, url.searchParams, body)) as T;
      } catch (e) {
        throw toApiError(e);
      }
    }
    return super.request<T>(method, path, body); // not migrated yet: the old backend
  }

  private async search(q: URLSearchParams) {
    const platform = platformParam(q.get("platform"));
    const username = (q.get("username") ?? q.get("query") ?? "").trim();
    if (!username) throw new LocalError("invalid_query", "Enter a channel name", 422);
    return (await this.clients()[platform].search(username)).map(searchResult);
  }

  private async discoverLive(q: URLSearchParams) {
    const platform = platformParam(q.get("platform"));
    const limit = Math.max(1, Math.min(100, Number(q.get("limit") ?? 24) || 24));
    return (await this.clients()[platform].discoverLive(limit)).map(searchResult);
  }

  private async add(body: unknown) {
    const b = (body ?? {}) as { platform?: string; username?: string };
    const platform = platformParam(b.platform ?? null);
    const username = typeof b.username === "string" ? b.username.trim() : "";
    if (!username) throw new LocalError("invalid_query", "Enter a channel name", 422);
    return addStreamer(await resolveChannel(this.clients(), platform, username));
  }

  private async capabilities() {
    const creds = await getCredentials();
    const cap = (platform: Platform) => {
      const ok = creds[platform] !== null;
      const v = ok ? "supported" : "requires_configuration";
      return {
        platform,
        configured: ok,
        connection_status: "not_connected",
        capabilities: {
          search: v,
          live_status: v,
          discover_live: v,
          chat_monitoring: platform === "twitch" ? "requires_authorization" : "unsupported",
          capture: "supported",
        },
        notes:
          platform === "kick"
            ? ["Kick has no search API: add channels by their exact name.", "Kick chat is only delivered to servers (webhooks), so it isn't monitored."]
            : ["Chat monitoring needs Sign in with Twitch (user:read:chat)."],
      };
    };
    return [cap("twitch"), cap("kick")];
  }
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof LocalError) return new ApiError("http", e.message, e.status, { error: { code: e.code, message: e.message } });
  if (e instanceof PlatformError) {
    // Never 401: that would read as "signed out of StreamHunter"; it's the platform that refused.
    const status = e.kind === "not_configured" ? 503 : e.kind === "rate_limited" ? 429 : 502;
    const code = e.kind === "not_configured" ? "platform_not_configured" : `platform_${e.kind}`;
    return new ApiError("http", e.message, status, { error: { code, message: e.message } });
  }
  return new ApiError("http", e instanceof Error ? e.message : "Unexpected error", 500);
}
