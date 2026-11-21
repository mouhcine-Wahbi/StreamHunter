import { cap, type PlatformAdapter } from "./adapter";
import { getCredentials } from "./credentials";
import { chunks, PlatformError, type HttpDeps } from "./http";
import { num, str, time, type ChannelInfo } from "./types";

/**
 * YouTube Live through the official YouTube Data API v3 with the editor's own API key (public data
 * only, so no Google sign-in is needed). The API gives metadata, never video: recording uses the
 * same tab capture as Twitch and Kick, on the channel's /live page.
 *
 * Quota (documented costs): channels.list, videos.list, playlistItems.list, videoCategories.list = 1
 * unit; search.list = 100 units. A key gets 10,000 units a day (reset at midnight Pacific).
 * Live checks therefore never use search:
 *   1. each channel's public upload feed (youtube.com/feeds/videos.xml, no quota) gives its newest
 *      video IDs (a broadcast appears there when it goes live);
 *      if the feed can't be read, the channel's uploads playlist (playlistItems.list, 1 unit);
 *   2. one videos.list call per 50 IDs says which are live now, with viewers and start time.
 * Search and "live now" use search.list (100 units) and only run when the editor asks.
 */
export const YT_API = "https://www.googleapis.com/youtube/v3";
export const YT_FEED = "https://www.youtube.com/feeds/videos.xml";
const QUOTA_KEY = "sh.youtubeQuota";
const LIVE_KEY = "sh.youtubeLive"; // channel id → live video id seen last time
/** Units StreamHunter allows itself per day (the key's total is 10,000). */
export const DAILY_BUDGET = 8000;
const FEED_IDS = 5;

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;

/** Calendar day in YouTube's quota time zone. */
export function quotaDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);
}

export async function quotaUsed(now = new Date()): Promise<number> {
  const q = (await chrome.storage.local.get(QUOTA_KEY))[QUOTA_KEY] as { day?: string; used?: number } | undefined;
  return q?.day === quotaDay(now) ? (q.used ?? 0) : 0;
}

async function spend(units: number, now: Date): Promise<void> {
  const used = await quotaUsed(now);
  if (used + units > DAILY_BUDGET)
    throw new PlatformError("youtube", "rate_limited", `StreamHunter's daily YouTube budget (${DAILY_BUDGET.toLocaleString("en")} of 10,000 units) is used up. YouTube checks resume after midnight Pacific time.`, 429, secondsToPacificMidnight(now));
  await chrome.storage.local.set({ [QUOTA_KEY]: { day: quotaDay(now), used: used + units } });
}

function secondsToPacificMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return Math.max(60, (24 * 60 - (h * 60 + m)) * 60);
}

export type Item = Record<string, unknown>;
export const obj = (v: unknown): Item => (typeof v === "object" && v !== null ? (v as Item) : {});
export const items = (body: unknown): Item[] => (Array.isArray(obj(body).items) ? (obj(body).items as unknown[]).map(obj) : []);

/** Pull a channel ID, handle or video ID out of whatever the editor pasted. */
export function parseYouTubeInput(input: string): { kind: "id" | "handle" | "video"; value: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith("video:") && VIDEO_ID.test(raw.slice(6))) return { kind: "video", value: raw.slice(6) };
  if (CHANNEL_ID.test(raw)) return { kind: "id", value: raw };
  if (raw.startsWith("@")) return /^@[\w.-]{3,30}$/.test(raw) ? { kind: "handle", value: raw.slice(1) } : null;
  let u: URL | null = null;
  try {
    u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    u = null;
  }
  const host = u?.hostname.replace(/^(www|m|music)\./, "") ?? "";
  if (u && host === "youtu.be") {
    const id = u.pathname.slice(1);
    return VIDEO_ID.test(id) ? { kind: "video", value: id } : null;
  }
  if (u && host === "youtube.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1] && CHANNEL_ID.test(parts[1])) return { kind: "id", value: parts[1] };
    if (parts[0]?.startsWith("@")) return { kind: "handle", value: parts[0].slice(1) };
    if (parts[0] === "watch" && VIDEO_ID.test(u.searchParams.get("v") ?? "")) return { kind: "video", value: u.searchParams.get("v")! };
    if (parts[0] === "live" && parts[1] && VIDEO_ID.test(parts[1])) return { kind: "video", value: parts[1] };
    return null; // legacy /c/ and /user/ links can't be resolved without a 100-unit search
  }
  return /^[\w.-]{3,30}$/.test(raw) ? { kind: "handle", value: raw } : null;
}

/** Video IDs in a channel's upload feed (Atom), newest first. */
export function feedVideoIds(xml: string, max = FEED_IDS): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)) if (out.length < max) out.push(m[1]!);
  return out;
}

/** Quota-counted, key-authenticated Data API GET, with YouTube's documented errors mapped to plain words. */
export function youTubeApi(http: HttpDeps = {}, now: () => Date = () => new Date()) {
  const fetchImpl = http.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function key(): Promise<string> {
    const c = (await getCredentials()).youtube;
    if (!c) throw new PlatformError("youtube", "not_configured", "Add your YouTube Data API key in Settings → Platforms (Google Cloud console → APIs & Services → Credentials).");
    return c.apiKey;
  }

  async function get(path: string, params: Record<string, string>, units: number): Promise<unknown> {
    const k = await key();
    await spend(units, now());
    const qs = new URLSearchParams({ ...params, key: k }).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), http.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetchImpl(`${YT_API}${path}?${qs}`, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    } catch {
      throw new PlatformError("youtube", "network", "YouTube could not be reached. Check the internet connection.");
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return body;
    // Documented error shape: { error: { code, message, errors: [{ reason }] } } (never echo the key).
    const reason = str(obj(((obj(obj(body).error).errors as unknown[]) ?? [])[0]).reason) ?? "";
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || res.status === 429)
      throw new PlatformError("youtube", "rate_limited", "This API key's daily YouTube quota is used up. YouTube checks resume after midnight Pacific time.", res.status, secondsToPacificMidnight(now()));
    if (reason === "keyInvalid" || reason === "forbidden" || reason === "accessNotConfigured" || res.status === 401 || res.status === 403)
      throw new PlatformError("youtube", "unauthorized", reason === "accessNotConfigured" ? "Enable the YouTube Data API v3 for this key's Google Cloud project." : "YouTube rejected the API key. Check it in Settings → Platforms.", res.status);
    throw new PlatformError("youtube", "http", `YouTube answered HTTP ${res.status}.`, res.status);
  }
  return { get, fetchImpl };
}

export function createYouTubeAdapter(http: HttpDeps = {}, now: () => Date = () => new Date()): PlatformAdapter {
  const { get, fetchImpl } = youTubeApi(http, now);
  const categories = new Map<string, string>();

  function fromChannel(c: Item): ChannelInfo | null {
    const id = str(c.id);
    if (!id) return null;
    const sn = obj(c.snippet);
    const handle = str(sn.customUrl)?.replace(/^@/, "");
    const thumbs = obj(sn.thumbnails);
    return {
      platform: "youtube",
      platform_user_id: id,
      username: (handle ?? id).toLowerCase(),
      display_name: str(sn.title) ?? handle ?? id,
      profile_image_url: str(obj(thumbs.default).url) ?? str(obj(thumbs.medium).url),
      is_live: null,
      current_title: null,
      current_category: null,
      viewer_count: null,
      stream_started_at: null,
    };
  }

  async function channels(params: Record<string, string>): Promise<ChannelInfo[]> {
    return items(await get("/channels", { part: "snippet", ...params }, 1)).map(fromChannel).filter((c): c is ChannelInfo => c !== null);
  }

  async function categoryNames(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !categories.has(id));
    if (missing.length === 0) return;
    for (const c of items(await get("/videoCategories", { part: "snippet", id: missing.join(",") }, 1).catch(() => null)))
      if (str(c.id)) categories.set(str(c.id)!, str(obj(c.snippet).title) ?? "");
  }

  /** videos.list → the ones that are live right now. */
  async function liveVideos(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const batch of chunks([...new Set(ids)], 50))
      for (const v of items(await get("/videos", { part: "snippet,liveStreamingDetails", id: batch.join(",") }, 1))) {
        const sn = obj(v.snippet);
        const live = obj(v.liveStreamingDetails);
        if (str(sn.liveBroadcastContent) === "live" && !str(live.actualEndTime)) out.push(v);
      }
    return out;
  }

  async function recentVideoIds(channelId: string): Promise<string[]> {
    try {
      const res = await fetchImpl(`${YT_FEED}?channel_id=${encodeURIComponent(channelId)}`, { headers: { Accept: "application/atom+xml" } });
      if (res.ok) return feedVideoIds(await res.text());
    } catch {
      /* fall back to the API */
    }
    // The uploads playlist of a channel is its ID with "UC" → "UU" (documented in channels.contentDetails).
    const body = await get("/playlistItems", { part: "contentDetails", playlistId: `UU${channelId.slice(2)}`, maxResults: String(FEED_IDS) }, 1);
    return items(body).map((i) => str(obj(i.contentDetails).videoId)).filter((x): x is string => x !== null);
  }

  async function toLiveInfo(videos: Item[], known: Map<string, ChannelInfo>): Promise<ChannelInfo[]> {
    await categoryNames(videos.map((v) => str(obj(v.snippet).categoryId)).filter((x): x is string => x !== null));
    return videos.flatMap((v): ChannelInfo[] => {
      const sn = obj(v.snippet);
      const live = obj(v.liveStreamingDetails);
      const channelId = str(sn.channelId);
      if (!channelId) return [];
      const base = known.get(channelId);
      return [{
        platform: "youtube",
        platform_user_id: channelId,
        username: base?.username ?? channelId.toLowerCase(),
        display_name: base?.display_name ?? str(sn.channelTitle) ?? channelId,
        profile_image_url: base?.profile_image_url ?? null,
        is_live: true,
        current_title: str(sn.title),
        current_category: categories.get(str(sn.categoryId) ?? "") || null,
        viewer_count: str(live.concurrentViewers) !== null ? num(Number(str(live.concurrentViewers))) : null,
        stream_started_at: time(live.actualStartTime),
        stream_id: str(v.id),
      }];
    });
  }

  return {
    platform: "youtube",
    label: "YouTube",

    capabilities: () => ({
      search: cap("partial", "untested", "search.list costs 100 of the key's 10,000 daily units, so it only runs when you search."),
      lookup: cap("supported", "untested", "Channel links, @handles, channel IDs and video links (1 unit)."),
      live_status: cap("supported", "untested", "Upload feed + one videos.list call per 50 videos: about 1 unit per check."),
      discover_live: cap("partial", "untested", "Uses search.list (100 units), only on request."),
      viewers: cap("supported", "untested", "concurrentViewers from videos.list."),
      chat: cap("unsupported", "untested", "Reading live chat costs quota on every poll; one stream would use the daily quota within hours."),
      capture: cap("supported", "untested", "Tab capture of youtube.com/…/live. Ads and autoplay muting apply."),
      native_clips: cap("unsupported", "untested", "The Data API has no clip creation."),
    }),

    async authStatus() {
      const c = (await getCredentials()).youtube;
      return c
        ? { configured: true, message: `API key saved. ${(await quotaUsed(now())).toLocaleString("en")} of ${DAILY_BUDGET.toLocaleString("en")} units used today.` }
        : { configured: false, message: "Add a YouTube Data API key (your own Google Cloud project)." };
    },

    async search(query) {
      // Links, IDs and @handles are a 1-unit lookup; only plain words use search.list (100 units).
      const p = parseYouTubeInput(query);
      if (p && (p.kind !== "handle" || /^@|\//.test(query.trim()))) return [await this.resolve(query)];
      const found = items(await get("/search", { part: "snippet", type: "channel", q: query, maxResults: "10" }, 100));
      const ids = found.map((r) => str(obj(r.id).channelId)).filter((x): x is string => x !== null);
      if (ids.length === 0) return [];
      const info = await channels({ id: ids.join(",") });
      const liveIds = new Set(found.filter((r) => str(obj(r.snippet).liveBroadcastContent) === "live").map((r) => str(obj(r.id).channelId)));
      return ids.map((id) => info.find((c) => c.platform_user_id === id)).filter((c): c is ChannelInfo => Boolean(c)).map((c) => ({ ...c, is_live: liveIds.has(c.platform_user_id) }));
    },

    async resolve(input) {
      const p = parseYouTubeInput(input);
      if (!p) throw new PlatformError("youtube", "http", "Paste a YouTube channel link (youtube.com/@name or /channel/UC…), an @handle, a channel ID or a video link.", 404);
      let found: ChannelInfo[];
      if (p.kind === "id") found = await channels({ id: p.value });
      else if (p.kind === "handle") found = await channels({ forHandle: `@${p.value}` });
      else {
        const v = items(await get("/videos", { part: "snippet", id: p.value }, 1))[0];
        const channelId = v ? str(obj(v.snippet).channelId) : null;
        found = channelId ? await channels({ id: channelId }) : [];
      }
      if (!found[0]) throw new PlatformError("youtube", "http", `No YouTube channel found for "${input.trim()}".`, 404);
      return found[0];
    },

    async discoverLive(limit) {
      const found = items(await get("/search", { part: "snippet", type: "video", eventType: "live", order: "viewCount", maxResults: String(Math.min(50, limit)) }, 100));
      const ids = found.map((r) => str(obj(r.id).videoId)).filter((x): x is string => x !== null);
      return toLiveInfo(await liveVideos(ids), new Map());
    },

    async status(list) {
      if (list.length === 0) return [];
      const known = new Map(list.map((c) => [c.platform_user_id, { ...c } as ChannelInfo]));
      const lastLive = ((await chrome.storage.local.get(LIVE_KEY))[LIVE_KEY] ?? {}) as Record<string, string>;
      const ids: string[] = [];
      for (const c of list) {
        if (lastLive[c.platform_user_id]) ids.push(lastLive[c.platform_user_id]!);
        ids.push(...(await recentVideoIds(c.platform_user_id)));
      }
      const live = (await liveVideos(ids)).filter((v) => known.has(str(obj(v.snippet).channelId) ?? ""));
      const nextLive: Record<string, string> = {};
      for (const v of live) nextLive[str(obj(v.snippet).channelId)!] = str(v.id)!;
      await chrome.storage.local.set({ [LIVE_KEY]: nextLive });
      // One entry per channel (a channel can run two broadcasts: keep the one with more viewers).
      const best = new Map<string, ChannelInfo>();
      for (const c of await toLiveInfo(live, known)) {
        const cur = best.get(c.platform_user_id);
        if (!cur || (c.viewer_count ?? 0) > (cur.viewer_count ?? 0)) best.set(c.platform_user_id, c);
      }
      return [...best.values()];
    },

    watchUrl: (c) => (CHANNEL_ID.test(c.platform_user_id) ? `https://www.youtube.com/channel/${c.platform_user_id}/live` : `https://www.youtube.com/@${c.username}/live`),

    parseUrl(u) {
      const host = u.hostname.replace(/^(www|m)\./, "");
      if (host !== "youtube.com" && host !== "youtu.be") return null;
      const p = parseYouTubeInput(u.toString());
      if (!p) return null;
      return { channel: p.kind === "video" ? `video:${p.value}` : p.kind === "handle" ? p.value.toLowerCase() : p.value };
    },
  };
}
