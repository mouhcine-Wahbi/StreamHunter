import type { Platform } from "@/types/api";

/** One channel as StreamHunter shows it, whichever platform it came from. */
export interface ChannelInfo {
  platform: Platform;
  platform_user_id: string;
  username: string;
  display_name: string;
  profile_image_url: string | null;
  /** null when the platform didn't say (e.g. Kick channel without stream data). */
  is_live: boolean | null;
  current_title: string | null;
  current_category: string | null;
  viewer_count: number | null;
  stream_started_at: string | null;
  /** The platform's ID of the current broadcast (Twitch stream ID, YouTube video ID), when it gives one. */
  stream_id?: string | null;
}

export interface PlatformClient {
  readonly platform: Platform;
  /** Twitch: fuzzy search. Kick has no search API: exact channel name lookup. */
  search(query: string): Promise<ChannelInfo[]>;
  /** Live channels, most viewers first. */
  discoverLive(limit: number): Promise<ChannelInfo[]>;
  /** Current state of saved channels, batched. Channels missing from the answer are offline. */
  status(channels: { platform_user_id: string; username: string }[]): Promise<ChannelInfo[]>;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ISO time, or null for missing or Go's zero time ("0001-01-01…", Kick's "never"). */
export function time(v: unknown): string | null {
  const s = str(v);
  if (!s || s.startsWith("0001-01-01")) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function dataList(body: unknown): Record<string, unknown>[] {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}
