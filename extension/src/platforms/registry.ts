import type { Platform } from "@/types/api";
import { cap, type PlatformAdapter } from "./adapter";
import { getCredentials } from "./credentials";
import { PlatformError, type HttpDeps } from "./http";
import { createKickClient } from "./kick";
import { createTwitchClient } from "./twitch";
import { getTwitchUser } from "./twitch-user";
import type { ChannelInfo, PlatformClient } from "./types";
import { createYouTubeAdapter } from "./youtube";
import { channelFromUrl } from "@/types/capture";

export type Adapters = Record<Platform, PlatformAdapter>;

/** Exact-name match from a platform's search (Twitch: fuzzy search; Kick: lookup by slug). */
async function exact(client: PlatformClient, label: string, input: string): Promise<ChannelInfo> {
  const name = nameFromInput(input);
  const found = await client.search(name);
  const match = found.find((c) => c.username.toLowerCase() === name.toLowerCase());
  if (!match) throw new PlatformError(client.platform, "http", `No ${label} channel named "${name}"`, 404);
  return match;
}

/** "https://www.twitch.tv/name", "twitch.tv/name" or "name" → "name". */
function nameFromInput(input: string): string {
  const raw = input.trim();
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : raw.includes(".") ? `https://${raw}` : "x:");
    const first = u.pathname.split("/").filter(Boolean)[0];
    if (first && /(twitch\.tv|kick\.com)$/.test(u.hostname)) return first;
  } catch {
    /* plain name */
  }
  return raw.replace(/^@/, "");
}

export function twitchAdapter(http: HttpDeps = {}): PlatformAdapter {
  const client = createTwitchClient(http);
  return {
    ...client,
    label: "Twitch",
    capabilities: () => ({
      search: cap("supported", "simulated", "Helix Search Channels."),
      lookup: cap("supported", "simulated", "By channel name or twitch.tv link."),
      live_status: cap("supported", "simulated", "Get Streams, 100 channels per request."),
      discover_live: cap("supported", "simulated", "Get Streams, most viewers first."),
      viewers: cap("supported", "simulated", "viewer_count from Get Streams."),
      chat: cap("partial", "simulated", "EventSub chat after Sign in with Twitch (user:read:chat)."),
      capture: cap("supported", "verified", "Tab capture of twitch.tv/<channel> (tested in Chrome)."),
      native_clips: cap("partial", "untested", "Optional Create Clip with the clips:edit permission."),
    }),
    async authStatus() {
      const [c, user] = await Promise.all([getCredentials(), getTwitchUser()]);
      if (!c.twitch) return { configured: false, message: "Add your Twitch app's client ID (and secret, or Sign in with Twitch)." };
      if (!c.twitch.clientSecret && !user) return { configured: false, message: "No secret saved: Sign in with Twitch to use the API." };
      return { configured: true, message: c.twitch.clientSecret ? "App credentials saved." : `Using your sign-in (${user!.login}), no secret stored.` };
    },
    resolve: (input) => exact(client, "Twitch", input),
    watchUrl: (c) => `https://www.twitch.tv/${c.username}`,
    parseUrl: (u) => {
      const c = channelFromUrl(u.toString());
      return c && c.platform === "twitch" ? { channel: c.channel } : null;
    },
  };
}

export function kickAdapter(http: HttpDeps = {}): PlatformAdapter {
  const client = createKickClient(http);
  return {
    ...client,
    label: "Kick",
    capabilities: () => ({
      search: cap("partial", "simulated", "Kick's API has no search: exact channel name only."),
      lookup: cap("supported", "simulated", "Channels by slug (kick.com/<name>)."),
      live_status: cap("supported", "simulated", "Channels endpoint, 50 per request."),
      discover_live: cap("supported", "simulated", "Livestreams endpoint, most viewers first."),
      viewers: cap("supported", "simulated", "viewer_count from the channel's stream."),
      chat: cap("unsupported", "simulated", "Kick delivers chat only to servers (webhooks)."),
      capture: cap("supported", "untested", "Tab capture of kick.com/<channel>."),
      native_clips: cap("unsupported", "untested", "No clip endpoint in Kick's public API."),
    }),
    async authStatus() {
      const c = (await getCredentials()).kick;
      return c ? { configured: true, message: "App credentials saved." } : { configured: false, message: "Add your Kick app's client ID and secret." };
    },
    resolve: (input) => exact(client, "Kick", input),
    watchUrl: (c) => `https://kick.com/${c.username}`,
    parseUrl: (u) => {
      const c = channelFromUrl(u.toString());
      return c && c.platform === "kick" ? { channel: c.channel } : null;
    },
  };
}

export function createAdapters(http: HttpDeps = {}): Adapters {
  return { twitch: twitchAdapter(http), kick: kickAdapter(http), youtube: createYouTubeAdapter(http) };
}
