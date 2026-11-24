/**
 * Content discovery (3.0): finds videos worth looking at. It never downloads anything.
 *
 * Sources (official APIs and the public channel feed only):
 *   creator uploads - your selected YouTube creators' public upload feed (youtube.com/feeds, no quota),
 *                     then one videos.list call per 50 videos for duration and statistics (1 unit);
 *   trending        - YouTube videos.list chart=mostPopular by region and category (1 unit);
 *                     Twitch Get Top Games + Get Clips per game (most-viewed clips of the period);
 *   keywords        - Twitch Search Categories → Get Clips of that category (free with your app);
 *                     YouTube search.list (100 units each) only when you turn it on.
 *
 * Each candidate gets a SOURCE POPULARITY score: how the original video is doing (views per hour,
 * engagement). It says nothing about the potential of a clip cut from it; that is scored later,
 * per clip, from what the clip itself contains.
 */
import { chunks, PlatformError } from "@/platforms/http";
import { items, obj, youTubeApi, type Item } from "@/platforms/youtube";
import { twitchHelix } from "@/platforms/twitch";
import { dataList, num, str, time } from "@/platforms/types";
import { db } from "@/local/db";
import { NO_RIGHTS, type Rights } from "@/local/rights";

export type DiscoveryVia = "creator_uploads" | "trending" | "keyword" | "clipper";
export type CandidateProcessing = "not_started" | "source_added" | "analyzing" | "analyzed" | "failed";

export interface Candidate {
  id: number;
  platform: "youtube" | "twitch";
  /** Platform video / clip ID. */
  source_id: string;
  kind: "video" | "clip" | "vod";
  title: string;
  creator_name: string;
  creator_id: string | null;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  category: string | null;
  language: string | null;
  via: DiscoveryVia[];
  /** Why it was found ("New upload from …", "Trending in Gaming (US)", "Keyword "…""). */
  reasons: string[];
  popularity: { score: number; explain: string[] };
  /** Rights for THIS item (creator-level rights may also apply). Discovered items start at unknown. */
  rights: Rights;
  /** 4.5 YouTube Video Clipper: your decision on this video as a source (with the basis for it). */
  clipper?: ClipperDecision;
  processing: CandidateProcessing;
  processing_error: string | null;
  dismissed: boolean;
  discovered_at: string;
  updated_at: string;
}

export type SourceBasis = "own" | "permission" | "licensed";
export interface ClipperDecision {
  approval: "approved" | "rejected";
  basis: SourceBasis | null;
  note: string;
  decided_at: string;
}

export type Found = Omit<Candidate, "id" | "popularity" | "rights" | "processing" | "processing_error" | "dismissed" | "discovered_at" | "updated_at" | "clipper">;

export interface DiscoveryFilters {
  /** Only videos published within this many days. */
  maxAgeDays: number;
  minViews: number;
  /** (likes + comments) / views, percent. Only applied where the platform reports them. */
  minEngagementPct: number;
  /** ISO 639-1, "" = any. */
  language: string;
}

/** ISO 8601 duration (PT1H2M3S) → seconds. */
export function isoDuration(v: string | null): number | null {
  const m = v ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v) : null;
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** Twitch VOD duration ("3h2m1s") → seconds. */
export function twitchDuration(v: string | null): number | null {
  const m = v ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v) : null;
  return m && v ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));

/**
 * Source popularity 0–100: views per hour since publishing (70%, log scale: 10/h → 0, 100,000/h → 100)
 * and engagement rate (30%: 5% likes+comments per view → 100). Measured numbers only.
 */
export function popularityOf(f: Pick<Found, "views" | "likes" | "comments" | "published_at">, now: Date): { score: number; explain: string[] } {
  const explain: string[] = [];
  if (f.views === null) return { score: 0, explain: ["The platform reports no view count, so popularity can't be measured."] };
  const hours = f.published_at ? Math.max(1, (now.getTime() - Date.parse(f.published_at)) / 3_600_000) : null;
  const perHour = hours ? f.views / hours : null;
  const velocity = perHour !== null ? clamp(((Math.log10(Math.max(1, perHour)) - 1) / 4) * 100) : clamp(((Math.log10(Math.max(1, f.views)) - 2) / 5) * 100);
  explain.push(
    perHour !== null
      ? `${f.views.toLocaleString("en")} views in ${hours! < 48 ? `${Math.round(hours!)} h` : `${Math.round(hours! / 24)} days`} (${Math.round(perHour).toLocaleString("en")}/h) → ${velocity}.`
      : `${f.views.toLocaleString("en")} views (publish date unknown) → ${velocity}.`,
  );
  let score = velocity;
  if (f.likes !== null || f.comments !== null) {
    const rate = f.views > 0 ? ((f.likes ?? 0) + (f.comments ?? 0)) / f.views : 0;
    const engagement = clamp((rate / 0.05) * 100);
    explain.push(`Engagement ${(rate * 100).toFixed(1)}% (likes + comments per view) → ${engagement}.`);
    score = clamp(velocity * 0.7 + engagement * 0.3);
  } else explain.push("No like/comment counts from this platform: popularity uses views only.");
  explain.push("This measures the ORIGINAL video, not the potential of a clip from it.");
  return { score, explain };
}

export function passesFilters(f: Found, filters: DiscoveryFilters, now: Date): boolean {
  if (filters.maxAgeDays > 0 && f.published_at && now.getTime() - Date.parse(f.published_at) > filters.maxAgeDays * 86_400_000) return false;
  if (filters.minViews > 0 && (f.views ?? 0) < filters.minViews) return false;
  if (filters.minEngagementPct > 0 && f.views && (f.likes !== null || f.comments !== null) && (((f.likes ?? 0) + (f.comments ?? 0)) / f.views) * 100 < filters.minEngagementPct) return false;
  if (filters.language && f.language && !f.language.toLowerCase().startsWith(filters.language.toLowerCase())) return false;
  return true;
}

// --- YouTube ---------------------------------------------------------------------------------------

type YtApi = ReturnType<typeof youTubeApi>;

function fromYouTubeVideo(v: Item, via: DiscoveryVia, reason: string, categoryName?: string): Found | null {
  const id = str(v.id);
  const sn = obj(v.snippet);
  if (!id || ["live", "upcoming"].includes(str(sn.liveBroadcastContent) ?? "")) return null; // live streams are for Live Monitoring
  const stats = obj(v.statistics);
  const th = obj(sn.thumbnails);
  const n = (x: unknown) => (str(x) !== null ? num(Number(str(x))) : null);
  return {
    platform: "youtube",
    source_id: id,
    kind: "video",
    title: str(sn.title) ?? id,
    creator_name: str(sn.channelTitle) ?? "",
    creator_id: str(sn.channelId),
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail_url: str(obj(th.high).url) ?? str(obj(th.medium).url) ?? str(obj(th.default).url),
    published_at: time(sn.publishedAt),
    duration_seconds: isoDuration(str(obj(v.contentDetails).duration)),
    views: n(stats.viewCount),
    likes: n(stats.likeCount),
    comments: n(stats.commentCount),
    category: categoryName ?? null,
    language: str(sn.defaultAudioLanguage) ?? str(sn.defaultLanguage),
    via: [via],
    reasons: [reason],
  };
}

async function videoDetails(api: YtApi, ids: string[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const batch of chunks([...new Set(ids)], 50)) out.push(...items(await api.get("/videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") }, 1)));
  return out;
}

/** Newest uploads of your selected YouTube creators (feed: free; details: 1 unit per 50 videos). */
export async function youtubeCreatorUploads(api: YtApi, creators: { channelId: string; name: string }[], perCreator = 5): Promise<Found[]> {
  const ids: string[] = [];
  const nameOf = new Map<string, string>();
  for (const c of creators) {
    const res = await api.fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(c.channelId)}`, { headers: { Accept: "application/atom+xml" } }).catch(() => null);
    if (!res?.ok) continue;
    const xml = await res.text();
    for (const m of [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].slice(0, perCreator)) {
      ids.push(m[1]!);
      nameOf.set(m[1]!, c.name);
    }
  }
  if (ids.length === 0) return [];
  return (await videoDetails(api, ids)).map((v) => fromYouTubeVideo(v, "creator_uploads", `New upload from ${nameOf.get(str(v.id) ?? "") ?? str(obj(v.snippet).channelTitle) ?? "a selected creator"}`)).filter((x): x is Found => x !== null);
}

/** YouTube's most-popular chart for a region and category (1 unit). */
export async function youtubeTrending(api: YtApi, opts: { regionCode: string; categoryId: string; categoryName: string; max: number }): Promise<Found[]> {
  const body = await api.get("/videos", { part: "snippet,statistics,contentDetails", chart: "mostPopular", regionCode: opts.regionCode, ...(opts.categoryId ? { videoCategoryId: opts.categoryId } : {}), maxResults: String(Math.min(50, opts.max)) }, 1);
  return items(body).map((v) => fromYouTubeVideo(v, "trending", `Trending on YouTube${opts.categoryName ? ` in ${opts.categoryName}` : ""} (${opts.regionCode})`, opts.categoryName || undefined)).filter((x): x is Found => x !== null);
}

/** Keyword search on YouTube: 100 units + 1 for details. Only when you enable it. */
export async function youtubeKeyword(api: YtApi, opts: { q: string; publishedAfter: string | null; language: string; regionCode: string; max: number }): Promise<Found[]> {
  const body = await api.get("/search", {
    part: "snippet", type: "video", q: opts.q, order: "viewCount", maxResults: String(Math.min(25, opts.max)), regionCode: opts.regionCode,
    ...(opts.publishedAfter ? { publishedAfter: opts.publishedAfter } : {}), ...(opts.language ? { relevanceLanguage: opts.language } : {}),
  }, 100);
  const ids = items(body).map((i) => str(obj(i.id).videoId)).filter((x): x is string => x !== null);
  if (ids.length === 0) return [];
  return (await videoDetails(api, ids)).map((v) => fromYouTubeVideo(v, "keyword", `Keyword "${opts.q}" on YouTube`)).filter((x): x is Found => x !== null);
}

/** 4.5: one or more videos by id (videos.list, 1 unit per 50). Live and upcoming broadcasts are left out. */
export async function youtubeVideosById(api: YtApi, ids: string[], reason: string): Promise<Found[]> {
  if (!ids.length) return [];
  return (await videoDetails(api, ids)).map((v) => fromYouTubeVideo(v, "clipper", reason)).filter((x): x is Found => x !== null);
}

/** 4.5: Clipper search (search.list, 100 units, + videos.list for durations, 1 unit). */
export async function youtubeSearchVideos(api: YtApi, q: string, max = 10): Promise<Found[]> {
  const body = await api.get("/search", { part: "snippet", type: "video", q, maxResults: String(Math.min(25, max)) }, 100);
  const ids = items(body).map((i) => str(obj(i.id).videoId)).filter((x): x is string => x !== null);
  const found = await youtubeVideosById(api, ids, `Clipper search "${q}"`);
  // Keep YouTube's relevance order.
  return ids.map((id) => found.find((f) => f.source_id === id)).filter((x): x is Found => Boolean(x));
}

// --- Twitch ----------------------------------------------------------------------------------------

type Helix = ReturnType<typeof twitchHelix>;

function fromTwitchClip(c: Record<string, unknown>, via: DiscoveryVia, reason: string, category: string | null): Found | null {
  const id = str(c.id);
  if (!id) return null;
  return {
    platform: "twitch",
    source_id: `clip:${id}`,
    kind: "clip",
    title: str(c.title) ?? id,
    creator_name: str(c.broadcaster_name) ?? "",
    creator_id: str(c.broadcaster_id),
    url: str(c.url) ?? `https://clips.twitch.tv/${id}`,
    thumbnail_url: str(c.thumbnail_url),
    published_at: time(c.created_at),
    duration_seconds: num(c.duration),
    views: num(c.view_count),
    likes: null, // Twitch reports no likes/comments for clips
    comments: null,
    category,
    language: str(c.language),
    via: [via],
    reasons: [reason],
  };
}

/** Most-viewed clips of a Twitch category since `startedAt` (Get Clips, game_id). */
export async function twitchCategoryClips(get: Helix, game: { id: string; name: string }, startedAt: string, max: number, via: DiscoveryVia, reason: string): Promise<Found[]> {
  const list = dataList(await get("/clips", [["game_id", game.id], ["started_at", startedAt], ["first", String(Math.min(100, max))]]));
  return list.map((c) => fromTwitchClip(c, via, reason, game.name)).filter((x): x is Found => x !== null);
}

export async function twitchTopGames(get: Helix, n: number): Promise<{ id: string; name: string }[]> {
  return dataList(await get("/games/top", [["first", String(Math.min(100, n))]])).flatMap((g) => (str(g.id) && str(g.name) ? [{ id: str(g.id)!, name: str(g.name)! }] : []));
}

export async function twitchFindCategory(get: Helix, q: string): Promise<{ id: string; name: string } | null> {
  const g = dataList(await get("/search/categories", [["query", q], ["first", "5"]]));
  const exact = g.find((x) => str(x.name)?.toLowerCase() === q.toLowerCase()) ?? g[0];
  return exact && str(exact.id) && str(exact.name) ? { id: str(exact.id)!, name: str(exact.name)! } : null;
}

// --- store -----------------------------------------------------------------------------------------

/** Insert new candidates and refresh known ones (stats, reasons), never touching rights or processing. Returns how many were new. */
export async function upsertCandidates(found: Found[], now: Date): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const f of found) {
    const k = `${f.platform}|${f.source_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const prev = await db.oneByIndex<Candidate>("candidates", "source", [f.platform, f.source_id]);
    const at = now.toISOString();
    if (prev) {
      await db.put<Candidate>("candidates", {
        ...prev, ...f,
        via: [...new Set([...prev.via, ...f.via])],
        reasons: [...new Set([...prev.reasons, ...f.reasons])].slice(0, 6),
        popularity: popularityOf(f, now),
        updated_at: at,
      });
      updated += 1;
    } else {
      await db.put<Candidate>("candidates", {
        ...f, id: undefined as unknown as number, popularity: popularityOf(f, now), rights: { ...NO_RIGHTS },
        processing: "not_started", processing_error: null, dismissed: false, discovered_at: at, updated_at: at,
      });
      added += 1;
    }
  }
  return { added, updated };
}

export async function listCandidates(): Promise<Candidate[]> {
  return (await db.all<Candidate>("candidates")).sort((a, b) => b.popularity.score - a.popularity.score || b.discovered_at.localeCompare(a.discovered_at));
}

export interface DiscoveryRun {
  at: string;
  added: number;
  updated: number;
  /** source → error in plain words (not configured, quota, …). */
  problems: Record<string, string>;
  /** YouTube units used by this run. */
  units: number;
}

export const DISCOVERY_KEY = "sh.discovery";

const msg = (e: unknown) => (e instanceof PlatformError || e instanceof Error ? e.message : "Unexpected error");
export { msg as discoveryError };
