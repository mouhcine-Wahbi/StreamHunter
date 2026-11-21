import { PlatformError } from "@/platforms/http";
import { createAdapters, type Adapters } from "@/platforms/registry";
import type { ChannelInfo } from "@/platforms/types";
import type { Platform, Streamer, VerticalLayout } from "@/types/api";
import { db } from "./db";

export type Clients = Adapters;

let defaultClients: Clients | null = null;
export function platformClients(): Clients {
  defaultClients ??= createAdapters();
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
    // 2.0: StreamHunter records what you add, unless you turn Auto-record off.
    auto_record: true,
    priority: 0,
    discovery_enabled: info.platform === "youtube",
    updated_at: now(),
  });
}

/** Find a channel by its exact name on one platform (what "Add" uses). */
/** Find a channel from a name, link, handle or ID on one platform (what "Add" uses). */
export async function resolveChannel(clients: Clients, platform: Platform, input: string): Promise<ChannelInfo> {
  try {
    return await clients[platform].resolve(input);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) throw new LocalError("streamer_not_found", e.message, 404);
    throw e;
  }
}

export async function updateStreamer(id: number, patch: Partial<Pick<Streamer, "monitoring_enabled" | "is_favorite" | "auto_record" | "priority" | "discovery_enabled" | "layout">>): Promise<Streamer> {
  const s = await getStreamer(id);
  const next = { ...s, updated_at: now() };
  if (typeof patch.monitoring_enabled === "boolean") next.monitoring_enabled = patch.monitoring_enabled;
  if (typeof patch.is_favorite === "boolean") next.is_favorite = patch.is_favorite;
  if (typeof patch.auto_record === "boolean") next.auto_record = patch.auto_record;
  if (typeof patch.discovery_enabled === "boolean") next.discovery_enabled = patch.discovery_enabled;
  if (patch.layout === null) next.layout = null;
  else if (patch.layout) next.layout = sanitizeLayout(patch.layout);
  if (typeof patch.priority === "number" && Number.isFinite(patch.priority)) next.priority = Math.max(-2, Math.min(2, Math.round(patch.priority)));
  // Turning Auto-record back on gives a streamer that kept failing a fresh chance.
  if (patch.auto_record === true) Object.assign(next, { record_failures: 0, record_retry_at: null, record_error: null });
  return db.put("streamers", next);
}

const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** A layout from the dashboard: known kind, facecam rectangle inside the frame and not degenerate. */
export function sanitizeLayout(l: VerticalLayout): VerticalLayout {
  const kind = (["facecam_top", "action", "center"] as const).includes(l.kind) ? l.kind : "center";
  const f = l.facecam;
  if (kind !== "facecam_top" || !f) return { kind, facecam: null };
  const x = unit(f.x), y = unit(f.y);
  const w = Math.min(unit(f.w), 1 - x), h = Math.min(unit(f.h), 1 - y);
  return w >= 0.05 && h >= 0.05 ? { kind, facecam: { x, y, w, h } } : { kind: "center", facecam: null };
}

export async function removeStreamer(id: number): Promise<void> {
  await getStreamer(id);
  await db.delete("streamers", id);
}

export interface StatusChange {
  streamer: Streamer;
  change: "went_live" | "went_offline";
}

/** Viewer numbers of the current broadcast, newest last (kept on the streamer, max 8). */
export type WithHistory = Streamer & { viewer_history?: number[] };

export interface ViewerSpike {
  streamer: Streamer;
  from: number;
  to: number;
}

/**
 * A sudden jump in viewers (raids, hosts, a clip going viral): at least 1.5× and +100 over the
 * median of the previous checks of this broadcast. A weak, provisional signal; it works on Kick too.
 */
export function viewerSpike(history: number[], current: number): { from: number; to: number } | null {
  if (history.length < 3) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median >= 30 && current >= median * 1.5 && current - median >= 100 ? { from: median, to: current } : null;
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
  /** Streamers whose state was actually checked this time. */
  checked_ids: number[];
  spikes: ViewerSpike[];
}

/**
 * One live-status check of every monitored streamer: one batched request per platform
 * (100 Twitch / 50 Kick channels each). Streamers missing from the answer are offline.
 * A platform that fails keeps its streamers' last known state.
 */
export async function refreshStatuses(clients: Clients = platformClients(), at: Date = new Date()): Promise<RefreshResult> {
  const streamers = (await db.all<Streamer>("streamers")).filter((s) => s.monitoring_enabled);
  const result: RefreshResult = { checked: 0, live: 0, skipped_recent: 0, unavailable: {}, retry_after: {}, changes: [], checked_ids: [], spikes: [] };
  for (const platform of ["twitch", "kick", "youtube"] as const) {
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
      const prev = s as WithHistory;
      const sameBroadcast = c && prev.is_live && prev.stream_started_at === c.stream_started_at;
      const history = sameBroadcast ? (prev.viewer_history ?? []) : [];
      const viewers = c?.viewer_count ?? null;
      const spike = viewers !== null ? viewerSpike(history, viewers) : null;
      const next: WithHistory = {
        viewer_history: viewers !== null ? [...history, viewers].slice(-8) : [],
        ...s,
        is_live: Boolean(c),
        viewer_count: c?.viewer_count ?? null,
        stream_started_at: c?.stream_started_at ?? null,
        broadcast_id: c ? broadcastIdOf(c, prev, at) : null,
        current_title: c?.current_title ?? s.current_title,
        current_category: c?.current_category ?? s.current_category,
        display_name: c?.display_name && platform !== "kick" ? c.display_name : s.display_name,
        status_checked_at: at.toISOString(),
        updated_at: at.toISOString(),
      };
      await db.put("streamers", next);
      result.checked += 1;
      result.checked_ids.push(s.id);
      if (next.is_live) result.live += 1;
      if (next.is_live && s.is_live !== true) result.changes.push({ streamer: next, change: "went_live" });
      if (spike) result.spikes.push({ streamer: next, ...spike });
      if (!next.is_live && s.is_live === true) result.changes.push({ streamer: next, change: "went_offline" });
    }
  }
  return result;
}

/**
 * Identity of a live broadcast: the platform's stream ID, else its start time, else (no data at all)
 * the check that first saw it live, kept while the streamer stays live.
 */
export function broadcastIdOf(c: ChannelInfo, prev: Streamer, at: Date): string {
  if (c.stream_id) return `${c.platform}:${c.stream_id}`;
  if (c.stream_started_at) return `${c.platform}:${c.platform_user_id}@${c.stream_started_at}`;
  if (prev.is_live && prev.broadcast_id) return prev.broadcast_id;
  return `${c.platform}:${c.platform_user_id}~${at.toISOString()}`;
}

export function streamUrl(s: Pick<Streamer, "platform" | "username"> & { platform_user_id?: string }): string {
  if (s.platform === "youtube")
    return s.platform_user_id && /^UC[\w-]{22}$/.test(s.platform_user_id)
      ? `https://www.youtube.com/channel/${s.platform_user_id}/live`
      : `https://www.youtube.com/@${s.username}/live`;
  return s.platform === "twitch" ? `https://www.twitch.tv/${s.username}` : `https://kick.com/${s.username}`;
}
