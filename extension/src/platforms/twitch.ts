import { appAuth } from "./app-auth";
import { chunks, requestJson, type HttpDeps } from "./http";
import { dataList, num, str, time, type ChannelInfo, type PlatformClient } from "./types";

export const HELIX = "https://api.twitch.tv/helix";
const MAX_IDS = 100; // Helix limit for user_id / login / id filters

/**
 * Twitch Helix with an app access token (the editor's own app).
 * Endpoints: Search Channels, Get Streams, Get Users. Cost: 1 point each; the app has 800/min.
 */
/** Authenticated Helix GET (app token, or your Sign in with Twitch token when no secret is set). */
export function twitchHelix(http: HttpDeps = {}) {
  const auth = appAuth("twitch", http);
  return async function get(path: string, params: [string, string][]): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    return auth.call((token, clientId) =>
      requestJson("twitch", `${HELIX}${path}${qs ? `?${qs}` : ""}`, {
        ...http,
        headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId, Accept: "application/json" },
      }),
    );
  };
}

export function createTwitchClient(http: HttpDeps = {}): PlatformClient & {
  users(ids: string[]): Promise<Map<string, { login: string; display_name: string; profile_image_url: string | null }>>;
} {
  const get = twitchHelix(http);

  async function users(ids: string[]) {
    const out = new Map<string, { login: string; display_name: string; profile_image_url: string | null }>();
    for (const batch of chunks([...new Set(ids)], MAX_IDS)) {
      for (const u of dataList(await get("/users", batch.map((id) => ["id", id])))) {
        const id = str(u.id);
        if (id) out.set(id, { login: str(u.login) ?? id, display_name: str(u.display_name) ?? str(u.login) ?? id, profile_image_url: str(u.profile_image_url) });
      }
    }
    return out;
  }

  function fromStream(s: Record<string, unknown>, profile: string | null = null): ChannelInfo | null {
    const id = str(s.user_id);
    if (!id || (str(s.type) ?? "live") !== "live") return null;
    const login = str(s.user_login) ?? id;
    return {
      platform: "twitch",
      platform_user_id: id,
      username: login,
      display_name: str(s.user_name) ?? login,
      profile_image_url: profile,
      is_live: true,
      current_title: str(s.title),
      current_category: str(s.game_name),
      viewer_count: num(s.viewer_count),
      stream_started_at: time(s.started_at),
      stream_id: str(s.id),
    };
  }

  async function withProfiles(list: ChannelInfo[]): Promise<ChannelInfo[]> {
    const missing = list.filter((c) => !c.profile_image_url).map((c) => c.platform_user_id);
    if (missing.length === 0) return list;
    const u = await users(missing);
    return list.map((c) => ({ ...c, profile_image_url: c.profile_image_url ?? u.get(c.platform_user_id)?.profile_image_url ?? null }));
  }

  return {
    platform: "twitch",
    users,

    async search(query) {
      const found = dataList(await get("/search/channels", [["query", query], ["first", "20"]]));
      const channels: ChannelInfo[] = found.flatMap((c) => {
        const id = str(c.id);
        const login = str(c.broadcaster_login);
        if (!id || !login) return [];
        return [{
          platform: "twitch" as const,
          platform_user_id: id,
          username: login,
          display_name: str(c.display_name) ?? login,
          profile_image_url: str(c.thumbnail_url), // Search Channels returns the profile image here
          is_live: typeof c.is_live === "boolean" ? c.is_live : null,
          current_title: str(c.title),
          current_category: str(c.game_name),
          viewer_count: null,
          stream_started_at: c.is_live ? time(c.started_at) : null,
        }];
      });
      // An exact match first, then live channels; viewer counts for the live ones (one more call).
      const q = query.toLowerCase();
      channels.sort((a, b) => Number(b.username === q) - Number(a.username === q) || Number(b.is_live) - Number(a.is_live));
      const live = channels.filter((c) => c.is_live).map((c) => c.platform_user_id);
      if (live.length === 0) return channels;
      const viewers = new Map((await this.status(live.map((id) => ({ platform_user_id: id, username: "" })))).map((c) => [c.platform_user_id, c]));
      return channels.map((c) => ({ ...c, viewer_count: viewers.get(c.platform_user_id)?.viewer_count ?? c.viewer_count }));
    },

    async discoverLive(limit) {
      const list = dataList(await get("/streams", [["first", String(Math.min(100, limit))]]))
        .map((s) => fromStream(s))
        .filter((c): c is ChannelInfo => c !== null);
      return withProfiles(list);
    },

    async status(channels) {
      const ids = [...new Set(channels.map((c) => c.platform_user_id))];
      const out: ChannelInfo[] = [];
      for (const batch of chunks(ids, MAX_IDS)) {
        const params: [string, string][] = [...batch.map((id): [string, string] => ["user_id", id]), ["first", String(MAX_IDS)]];
        for (const s of dataList(await get("/streams", params))) {
          const c = fromStream(s);
          if (c) out.push(c);
        }
      }
      return out;
    },
  };
}
