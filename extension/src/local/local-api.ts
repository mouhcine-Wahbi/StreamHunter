import { ApiClient, ApiError, type Method } from "@/services/api-client";
import { getCredentials } from "@/platforms/credentials";
import { PlatformError } from "@/platforms/http";
import type { ChannelInfo } from "@/platforms/types";
import type { CandidateStatus, Page, Platform, Streamer, StreamerSearchResult } from "@/types/api";
import { getSession, listSessions, syncSessions } from "./sessions";
import { deleteHighlight, getHighlight, listHighlights, setHighlightStatus, type LocalHighlight } from "./highlights";
import { deleteClip, listClips, renameClip, type LocalClip } from "./clips";
import { ACTIVITY_KEY, type ChatActivity } from "@/background/chat-manager";
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

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => Promise<unknown>;

function page<T>(items: T[], q: URLSearchParams): Page<T> {
  const limit = Math.max(1, Math.min(500, Number(q.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function notFound(what: string): never {
  throw new LocalError("not_found", `${what} not found`, 404);
}

/** Filters: platform, status, min_score, date_from, streamer_id, has_video; sort=score for "top". */
export function filterHighlights(all: LocalHighlight[], q: URLSearchParams): LocalHighlight[] {
  const minScore = Number(q.get("min_score") ?? 0) || 0;
  const from = q.get("date_from");
  let out = all.filter(
    (h) =>
      h.score >= minScore &&
      (!q.get("platform") || h.platform === q.get("platform")) &&
      (!q.get("status") || h.status === q.get("status")) &&
      (!q.get("streamer_id") || h.streamer_id === Number(q.get("streamer_id"))) &&
      (!q.get("has_video") || h.has_video === (q.get("has_video") === "true")) &&
      (!from || h.timestamp >= from),
  );
  if (q.get("sort") === "score") out = [...out].sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
  return out;
}

function sortClips(all: LocalClip[], q: URLSearchParams): LocalClip[] {
  return q.get("sort") === "score" ? [...all].sort((a, b) => b.score - a.score) : all;
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
 * StreamHunter's API, answered inside the extension (IndexedDB + the Twitch/Kick APIs). There is no
 * server: the `/api/v1/...` paths are only an internal address scheme the pages use.
 */
export class LocalApi extends ApiClient {
  private readonly routes: [Method, RegExp, Handler][];

  constructor(private readonly clients: () => Clients = platformClients) {
    super();
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
      ["GET", /^\/api\/v1\/monitoring\/(\d+)\/activity$/, (m) => this.activity(Number(m[1]))],
      ["GET", /^\/api\/v1\/highlights$/, async (_m, q) => page(filterHighlights(await listHighlights(), q), q)],
      ["GET", /^\/api\/v1\/highlights\/(\d+)$/, async (m) => (await getHighlight(Number(m[1]))) ?? notFound("Highlight")],
      ["POST", /^\/api\/v1\/highlights\/(\d+)\/approve$/, (m) => setHighlightStatus(Number(m[1]), "approved")],
      ["POST", /^\/api\/v1\/highlights\/(\d+)\/reject$/, (m) => setHighlightStatus(Number(m[1]), "rejected")],
      ["PATCH", /^\/api\/v1\/highlights\/(\d+)$/, (m, _q, b) => setHighlightStatus(Number(m[1]), ((b ?? {}) as { status: CandidateStatus }).status)],
      ["DELETE", /^\/api\/v1\/highlights\/(\d+)$/, async (m) => void (await deleteHighlight(Number(m[1])))],
      ["GET", /^\/api\/v1\/clips$/, async (_m, q) => page(sortClips(await listClips(), q), q)],
      ["PATCH", /^\/api\/v1\/clips\/(\d+)$/, (m, _q, b) => renameClip(Number(m[1]), String(((b ?? {}) as { title?: unknown }).title ?? ""))],
      ["DELETE", /^\/api\/v1\/clips\/(\d+)$/, async (m) => void (await deleteClip(Number(m[1])))],
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
    throw new ApiError("http", `Not found: ${method} ${url.pathname}`, 404, { error: { code: "not_found", message: "Not found" } });
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

  private async activity(sessionId: number) {
    const session = (await getSession(sessionId)) ?? notFound("Session");
    const all = ((await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY] ?? {}) as ChatActivity;
    const a = all[String(session.streamer_id)];
    const base = a ?? { chat_state: "connecting", chat_reason: null };
    return { session_id: session.id, streamer_id: session.streamer_id, ...base, ...(session.status !== "active" ? { chat_state: "not_monitored" } : {}) };
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
