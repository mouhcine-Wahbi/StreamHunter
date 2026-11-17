import { PlatformError } from "@/platforms/http";
import { createKickClient } from "@/platforms/kick";
import { createTwitchClient } from "@/platforms/twitch";
import type { ChannelInfo, PlatformClient } from "@/platforms/types";
import type { Platform, Streamer } from "@/types/api";
import { db } from "./db";

export type Clients = Record<Platform, PlatformClient>;

let defaultClients: Clients | null = null;
export function platformClients(): Clients {
  defaultClients ??= { twitch: createTwitchClient(), kick: createKickClient() };
  return defaultClients;
}

export class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();

export async function listStreamers(): Promise<Streamer[]> {
  const all = await db.all<Streamer>("streamers");
  // Live first, then favourites, then by name.
  return all.sort(
    (a, b) =>
      Number(b.is_live === true) - Number(a.is_live === true) ||
      Number(b.is_favorite) - Number(a.is_favorite) ||
      a.display_name.localeCompare(b.display_name),
  );
}

export async function getStreamer(id: number): Promise<Streamer> {
  const s = await db.get<Streamer>("streamers", id);
  if (!s) throw new LocalError("not_found", "That streamer is not on your monitoring list", 404);
  return s;
}

export async function addStreamer(info: ChannelInfo): Promise<Streamer> {
  const existing = await db.oneByIndex<Streamer>("streamers", "platformUser", [info.platform, info.platform_user_id]);
  if (existing) throw new LocalError("already_in_watchlist", `${existing.display_name} is already on your monitoring list`, 409);
  return db.put<Streamer>("streamers", {
    ...(info as Omit<Streamer, "id">),
    id: undefined as unknown as number,
    status_checked_at: now(),
    monitoring_enabled: true,
    is_favorite: false,
    updated_at: now(),
  });
}

/** Find a channel by its exact name on one platform (what "Add" uses). */
export async function resolveChannel(clients: Clients, platform: Platform, username: string): Promise<ChannelInfo> {
  const found = await clients[platform].search(username);
  const match = found.find((c) => c.username.toLowerCase() === username.toLowerCase());
  if (!match) throw new LocalError("streamer_not_found", `No ${platform === "twitch" ? "Twitch" : "Kick"} channel named "${username}"`, 404);
  return match;
}

export async function updateStreamer(id: number, patch: Partial<Pick<Streamer, "monitoring_enabled" | "is_favorite">>): Promise<Streamer> {
  const s = await getStreamer(id);
  const next = { ...s, updated_at: now() };
  if (typeof patch.monitoring_enabled === "boolean") next.monitoring_enabled = patch.monitoring_enabled;
  if (typeof patch.is_favorite === "boolean") next.is_favorite = patch.is_favorite;
  return db.put("streamers", next);
}

export async function removeStreamer(id: number): Promise<void> {
  await getStreamer(id);
  await db.delete("streamers", id);
}

export interface StatusChange {
  streamer: Streamer;
  change: "went_live" | "went_offline";
}

export interface RefreshResult {
  checked: number;
  live: number;
  skipped_recent: number;
  /** platform → why it couldn't be checked (not configured, rate limited…). */
  unavailable: Record<string, string>;
  /** Seconds the platform asked to wait (429), per platform. */
  retry_after: Record<string, number>;
  changes: StatusChange[];
}

/**
 * One live-status check of every monitored streamer: one batched request per platform
 * (100 Twitch / 50 Kick channels each). Streamers missing from the answer are offline.
 * A platform that fails keeps its streamers' last known state.
 */
export async function refreshStatuses(clients: Clients = platformClients(), at: Date = new Date()): Promise<RefreshResult> {
  const streamers = (await db.all<Streamer>("streamers")).filter((s) => s.monitoring_enabled);
  const result: RefreshResult = { checked: 0, live: 0, skipped_recent: 0, unavailable: {}, retry_after: {}, changes: [] };
  for (const platform of ["twitch", "kick"] as const) {
    const group = streamers.filter((s) => s.platform === platform);
    if (group.length === 0) continue;
    let live: ChannelInfo[];
    try {
      live = await clients[platform].status(group);
    } catch (e) {
      result.unavailable[platform] = e instanceof Error ? e.message : "Unexpected error";
      if (e instanceof PlatformError && e.retryAfterSec) result.retry_after[platform] = e.retryAfterSec;
      continue;
    }
    const byId = new Map(live.map((c) => [c.platform_user_id, c]));
    for (const s of group) {
      const c = byId.get(s.platform_user_id);
      const next: Streamer = {
        ...s,
        is_live: Boolean(c),
        viewer_count: c?.viewer_count ?? null,
        stream_started_at: c?.stream_started_at ?? null,
        current_title: c?.current_title ?? s.current_title,
        current_category: c?.current_category ?? s.current_category,
        display_name: c?.display_name && platform === "twitch" ? c.display_name : s.display_name,
        status_checked_at: at.toISOString(),
        updated_at: at.toISOString(),
      };
      await db.put("streamers", next);
      result.checked += 1;
      if (next.is_live) result.live += 1;
      if (next.is_live && s.is_live !== true) result.changes.push({ streamer: next, change: "went_live" });
      if (!next.is_live && s.is_live === true) result.changes.push({ streamer: next, change: "went_offline" });
    }
  }
  return result;
}

export function streamUrl(s: Pick<Streamer, "platform" | "username">): string {
  return s.platform === "twitch" ? `https://www.twitch.tv/${s.username}` : `https://kick.com/${s.username}`;
}
