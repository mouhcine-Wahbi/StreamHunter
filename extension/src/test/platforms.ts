import { setCredentials } from "@/platforms/credentials";
import { json, mockFetch } from "./http";

/** A fake Twitch + Kick, answering the official endpoints StreamHunter calls. */
export interface FakeChannel {
  id: string;
  login: string;
  name?: string;
  live?: boolean;
  viewers?: number;
  title?: string;
  game?: string;
}

export interface FakePlatformsOptions {
  twitch?: FakeChannel[];
  kick?: FakeChannel[];
  /** Respond to Helix/Kick API calls with this status instead (e.g. 429). */
  failWith?: Partial<Record<"twitch" | "kick", number>>;
}

export async function configurePlatforms(): Promise<void> {
  await setCredentials("twitch", { clientId: "tw-client", clientSecret: "tw-secret" });
  await setCredentials("kick", { clientId: "kk-client", clientSecret: "kk-secret" });
}

export function fakePlatforms(opts: FakePlatformsOptions, fallback: (url: string, init?: RequestInit) => Response | null = () => null) {
  const twitch = () => opts.twitch ?? [];
  const kick = () => opts.kick ?? [];
  const calls: string[] = [];
  const fetch = mockFetch((url, init) => {
    const u = new URL(url);
    if (u.host === "id.twitch.tv" || u.host === "id.kick.com") {
      calls.push(`${u.host} token`);
      return json({ access_token: `${u.host}-token`, expires_in: 3600, token_type: "bearer" });
    }
    if (u.host === "api.twitch.tv") {
      calls.push(`twitch ${u.pathname}${u.search}`);
      if (opts.failWith?.twitch) return json({ message: "nope" }, opts.failWith.twitch);
      const ids = u.searchParams.getAll("user_id").concat(u.searchParams.getAll("id"));
      if (u.pathname === "/helix/search/channels") {
        const q = (u.searchParams.get("query") ?? "").toLowerCase();
        return json({ data: twitch().filter((c) => c.login.includes(q)).map((c) => ({
          id: c.id, broadcaster_login: c.login, display_name: c.name ?? c.login, is_live: !!c.live, title: c.title ?? "",
          game_name: c.game ?? "", thumbnail_url: `https://img/${c.login}.png`, started_at: c.live ? "2026-11-17T10:00:00Z" : "" })) });
      }
      if (u.pathname === "/helix/streams") {
        const list = twitch().filter((c) => c.live && (ids.length === 0 || ids.includes(c.id)));
        return json({ data: list.map((c) => ({ user_id: c.id, user_login: c.login, user_name: c.name ?? c.login, type: "live",
          title: c.title ?? "", game_name: c.game ?? "", viewer_count: c.viewers ?? 0, started_at: "2026-11-17T10:00:00Z" })) });
      }
      if (u.pathname === "/helix/users") {
        return json({ data: twitch().filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, login: c.login, display_name: c.name ?? c.login,
          profile_image_url: `https://img/${c.login}.png` })) });
      }
    }
    if (u.host === "api.kick.com") {
      calls.push(`kick ${u.pathname}${u.search}`);
      if (opts.failWith?.kick) return json({ message: "nope" }, opts.failWith.kick);
      if (u.pathname === "/public/v1/channels") {
        const slugs = u.searchParams.getAll("slug");
        return json({ data: kick().filter((c) => slugs.includes(c.login)).map((c) => ({
          broadcaster_user_id: Number(c.id), slug: c.login, stream_title: c.title ?? "", category: { id: 1, name: c.game ?? "Just Chatting" },
          stream: { is_live: !!c.live, viewer_count: c.viewers ?? 0, start_time: c.live ? "2026-11-17T10:00:00Z" : "0001-01-01T00:00:00Z" } })) });
      }
      if (u.pathname === "/public/v1/users") {
        const idList = u.searchParams.getAll("id");
        return json({ data: kick().filter((c) => idList.includes(c.id)).map((c) => ({ user_id: Number(c.id), name: c.login, profile_picture: `https://kimg/${c.login}.png` })) });
      }
      if (u.pathname === "/public/v1/livestreams") {
        return json({ data: kick().filter((c) => c.live).map((c) => ({ broadcaster_user_id: Number(c.id), slug: c.login, stream_title: c.title ?? "",
          viewer_count: c.viewers ?? 0, started_at: "2026-11-17T10:00:00Z", category: { name: c.game ?? "" }, profile_picture: `https://kimg/${c.login}.png` })) });
      }
    }
    return fallback(url, init);
  });
  return { fetch, calls };
}
