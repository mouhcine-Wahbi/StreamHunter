import { db } from "@/local/db";
import { ApiClient, ApiError, type Method } from "@/services/api-client";
import { PlatformError } from "@/platforms/http";
import type { ChannelInfo } from "@/platforms/types";
import type { CandidateStatus, Page, Platform, Streamer, StreamerSearchResult } from "@/types/api";
import { getSession, listSessions, syncSessions } from "./sessions";
import { deleteHighlight, getHighlight, listHighlights, setHighlightStatus, type LocalHighlight } from "./highlights";
import { clipStats, deleteClip, listClips, updateClip, type LocalClip } from "./clips";
import { ACTIVITY_KEY, type ChatActivity } from "@/background/chat-manager";
import { v3Routes } from "./v3-routes";
import { RightsError } from "./rights";
import { ContentError } from "./content";
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
      (!q.get("clip_status") || q.get("clip_status")!.split(",").includes(h.clip_status ?? "")) &&
      (!from || h.timestamp >= from),
  );
  if (q.get("sort") === "score") out = [...out].sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
  return out;
}

/** Duration buckets for the clip filters. */
export const DURATION_BUCKETS = { short: [0, 30], medium: [30, 60], long: [60, Infinity] } as const;

/**
 * Clip filters: platform, streamer_id, category, duration (short|medium|long), type (a detection
 * type), favorite, min_score; sort=score (highest first, default "recent").
 */
export function filterClips(all: LocalClip[], q: URLSearchParams): LocalClip[] {
  const minScore = Number(q.get("min_score") ?? 0) || 0;
  const bucket = DURATION_BUCKETS[(q.get("duration") ?? "") as keyof typeof DURATION_BUCKETS];
  const out = all.filter(
    (c) =>
      c.score >= minScore &&
      (!q.get("platform") || c.platform === q.get("platform")) &&
      (!q.get("streamer_id") || c.streamer_id === Number(q.get("streamer_id"))) &&
      (!q.get("category") || (c.category ?? "") === q.get("category")) &&
      (!bucket || ((c.duration_seconds ?? 0) >= bucket[0] && (c.duration_seconds ?? 0) < bucket[1])) &&
      (!q.get("type") || c.detection_types.includes(q.get("type") as LocalClip["detection_types"][number])) &&
      (q.get("favorite") !== "true" || c.favorite) &&
      (!q.get("since") || c.created_at >= q.get("since")!),
  );
  if (q.get("sort") === "score") return [...out].sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at));
  if (q.get("sort") === "oldest") return [...out].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

function platformParam(v: string | null): Platform {
  if (v === "twitch" || v === "kick" || v === "youtube") return v;
  throw new LocalError("invalid_platform", "Choose Twitch, Kick or YouTube", 422);
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
 * StreamHunter's API, answered inside the extension (IndexedDB + the Twitch/Kick/YouTube APIs). There is no
 * server: the `/api/v1/...` paths are only an internal address scheme the pages use.
 */
export class LocalApi extends ApiClient {
  private readonly routes: [Method, RegExp, Handler][];

  constructor(private readonly clients: () => Clients = platformClients) {
    super();
    this.routes = [
      ["GET", /^\/api\/v1\/streamers\/search$/, (_m, q) => this.search(q)],
      ["GET", /^\/api\/v1\/discover\/live$/, (_m, q) => this.discoverLive(q)],
      ["GET", /^\/api\/v1\/streamers$/, async (_m, q) => {
        // Each streamer with how many clips StreamHunter made of them.
        const [list, clips] = await Promise.all([listStreamers(), listClips()]);
        const count = new Map<number, number>();
        for (const c of clips) count.set(c.streamer_id, (count.get(c.streamer_id) ?? 0) + 1);
        return page(list.map((s) => ({ ...s, clip_count: count.get(s.id) ?? 0 })), q);
      }],
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
      ["GET", /^\/api\/v1\/clips$/, async (_m, q) => page(filterClips(await listClips(), q), q)],
      ["GET", /^\/api\/v1\/clips\/stats$/, async () => this.stats()],
      ["PATCH", /^\/api\/v1\/clips\/(\d+)$/, (m, _q, b) => {
        const body = (b ?? {}) as { title?: unknown; favorite?: unknown };
        return updateClip(Number(m[1]), { title: body.title, favorite: body.favorite });
      }],
      ["DELETE", /^\/api\/v1\/clips\/(\d+)$/, async (m) => void (await deleteClip(Number(m[1])))],
      ...(v3Routes(page) as [Method, RegExp, Handler][]),
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

  /** Overview totals: clips, their size and length, recording time, browser storage use. */
  private async stats() {
    const [clips, rec, estimate, sources, assets] = await Promise.all([
      clipStats(),
      chrome.storage.local.get("sh.stats"),
      navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
      db.all<{ size_bytes: number }>("sources"),
      db.all<{ size_bytes: number; kind: string; status: string }>("assets"),
    ]);
    const recorded = (rec["sh.stats"] as { recordedSeconds?: number } | undefined)?.recordedSeconds ?? 0;
    return {
      clips: clips.count,
      favorites: clips.favorites,
      clip_bytes: clips.totalBytes,
      clip_seconds: clips.totalSeconds,
      recorded_seconds: recorded,
      storage_used_bytes: estimate?.usage ?? null,
      storage_quota_bytes: estimate?.quota ?? null,
      // 4.7: imported source files (Clipper) and made versions (vertical, landscape, edited Shorts).
      source_files: sources.length,
      source_bytes: sources.reduce((a, x) => a + (x.size_bytes || 0), 0),
      version_bytes: assets.filter((a) => a.status === "ready").reduce((a, x) => a + (x.size_bytes || 0), 0),
    };
  }

  /** Per platform: set up or not, and what is supported (and how it was checked), from its adapter. */
  private async capabilities() {
    const adapters = this.clients();
    return Promise.all(
      (["twitch", "kick", "youtube"] as const).map(async (platform) => {
        const a = adapters[platform];
        const auth = await a.authStatus();
        return { platform, label: a.label, configured: auth.configured, auth_message: auth.message, capabilities: a.capabilities() };
      }),
    );
  }
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof LocalError) return new ApiError("http", e.message, e.status, { error: { code: e.code, message: e.message } });
  if (e instanceof ContentError) return new ApiError("http", e.message, 422, { error: { code: "content", message: e.message } });
  if (e instanceof RightsError) return new ApiError("http", e.message, 422, { error: { code: "rights", message: e.message } });
  if (e instanceof PlatformError) {
    // Never 401: that would read as "signed out of StreamHunter"; it's the platform that refused.
    const status = e.kind === "not_configured" ? 503 : e.kind === "rate_limited" ? 429 : 502;
    const code = e.kind === "not_configured" ? "platform_not_configured" : `platform_${e.kind}`;
    return new ApiError("http", e.message, status, { error: { code, message: e.message } });
  }
  return new ApiError("http", e instanceof Error ? e.message : "Unexpected error", 500);
}
