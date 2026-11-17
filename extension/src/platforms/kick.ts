import { appAuth } from "./app-auth";
import { chunks, requestJson, type HttpDeps } from "./http";
import { dataList, num, str, time, type ChannelInfo, type PlatformClient } from "./types";

export const KICK_API = "https://api.kick.com/public/v1";
const MAX_PER_REQUEST = 50; // Kick: up to 50 slugs / ids per request

/**
 * Kick's official public API with an app access token (the editor's own app).
 * Kick has no search endpoint: "search" is an exact channel-name lookup.
 * Field names are parsed defensively (Kick's OpenAPI spec is the only per-field reference).
 */
export function createKickClient(http: HttpDeps = {}): PlatformClient {
  const auth = appAuth("kick", http);

  async function get(path: string, params: [string, string][]): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    return auth.call((token) =>
      requestJson("kick", `${KICK_API}${path}${qs ? `?${qs}` : ""}`, {
        ...http,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }),
    );
  }

  async function pictures(ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const batch of chunks([...new Set(ids)], MAX_PER_REQUEST)) {
      for (const u of dataList(await get("/users", batch.map((id) => ["id", id])))) {
        const id = str(u.user_id);
        if (id) out.set(id, str(u.profile_picture));
      }
    }
    return out;
  }

  function fromChannel(c: Record<string, unknown>): ChannelInfo | null {
    const id = str(c.broadcaster_user_id);
    const slug = str(c.slug);
    if (!id || !slug) return null;
    const stream = (typeof c.stream === "object" && c.stream) as Record<string, unknown> | false;
    const category = (typeof c.category === "object" && c.category) as Record<string, unknown> | false;
    const live = stream && typeof stream.is_live === "boolean" ? stream.is_live : null;
    return {
      platform: "kick",
      platform_user_id: id,
      username: slug.toLowerCase(),
      display_name: slug,
      profile_image_url: null,
      is_live: live,
      current_title: str(c.stream_title),
      current_category: category ? str(category.name) : null,
      viewer_count: live && stream ? num(stream.viewer_count) : null,
      stream_started_at: live && stream ? time(stream.start_time) : null,
    };
  }

  async function withPictures(list: ChannelInfo[]): Promise<ChannelInfo[]> {
    if (list.length === 0) return list;
    try {
      const pics = await pictures(list.map((c) => c.platform_user_id));
      return list.map((c) => ({ ...c, profile_image_url: c.profile_image_url ?? pics.get(c.platform_user_id) ?? null }));
    } catch {
      return list; // pictures are a nicety; never fail a search over them
    }
  }

  async function bySlugs(slugs: string[]): Promise<ChannelInfo[]> {
    const out: ChannelInfo[] = [];
    for (const batch of chunks([...new Set(slugs.map((s) => s.toLowerCase()))], MAX_PER_REQUEST)) {
      for (const c of dataList(await get("/channels", batch.map((s) => ["slug", s])))) {
        const info = fromChannel(c);
        if (info) out.push(info);
      }
    }
    return out;
  }

  return {
    platform: "kick",

    async search(query) {
      return withPictures(await bySlugs([query.trim()]));
    },

    async discoverLive(limit) {
      const list = dataList(await get("/livestreams", [["limit", String(Math.min(100, limit))], ["sort", "viewer_count"]]));
      return list.flatMap((s): ChannelInfo[] => {
        const id = str(s.broadcaster_user_id);
        const slug = str(s.slug);
        if (!id || !slug) return [];
        const category = (typeof s.category === "object" && s.category) as Record<string, unknown> | false;
        return [{
          platform: "kick",
          platform_user_id: id,
          username: slug.toLowerCase(),
          display_name: slug,
          profile_image_url: str(s.profile_picture),
          is_live: true,
          current_title: str(s.stream_title),
          current_category: category ? str(category.name) : null,
          viewer_count: num(s.viewer_count),
          stream_started_at: time(s.started_at),
        }];
      });
    },

    async status(channels) {
      return (await bySlugs(channels.map((c) => c.username))).filter((c) => c.is_live === true);
    },
  };
}
