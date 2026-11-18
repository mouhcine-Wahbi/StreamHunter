import type { Platform } from "@/types/api";
import type { ChannelInfo, PlatformClient } from "./types";

/**
 * One adapter per platform (Twitch, Kick, YouTube). The monitoring engine, scheduler and pages only
 * use this interface; everything platform-specific stays inside the adapter.
 *
 * Adding/removing a channel is local (the monitoring list in IndexedDB): the adapter's part is
 * `resolve` (turn a name, link or ID into a channel) and `status` (live state + stream metadata).
 */
export type Feature = "search" | "lookup" | "live_status" | "discover_live" | "viewers" | "chat" | "capture" | "native_clips";

/** What the platform allows through its official API (and the browser, for capture). */
export type Support = "supported" | "partial" | "unsupported";
/** How StreamHunter checked it: against the real service, against documented responses, or not yet. */
export type Verification = "verified" | "simulated" | "untested";

export interface Capability {
  support: Support;
  verified: Verification;
  note: string;
}

export interface AuthStatus {
  configured: boolean;
  /** What the editor needs to do, or what is set up. */
  message: string;
}

export interface PlatformAdapter extends PlatformClient {
  readonly platform: Platform;
  readonly label: string;
  capabilities(): Record<Feature, Capability>;
  authStatus(): Promise<AuthStatus>;
  /** A channel from a name, handle, channel link or ID (what "Add" uses). Throws when not found. */
  resolve(input: string): Promise<ChannelInfo>;
  /** The page a recorder tab opens to watch this channel live. */
  watchUrl(c: { platform_user_id: string; username: string }): string;
  /** The channel shown at a URL of this platform (manual capture), or null. */
  parseUrl(url: URL): { channel: string } | null;
}

export const cap = (support: Support, verified: Verification, note: string): Capability => ({ support, verified, note });
