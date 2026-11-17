import type { SoundKind } from "./api";

/**
 * Live tab audio: the editor lets StreamHunter measure the loudness of a Twitch/Kick tab.
 * By default only one loudness number per second is sent to the backend. With sound detection
 * on (opt-in), the tab's audio itself (16 kHz mono) also goes to the editor's own StreamHunter
 * backend, which recognises laughter, cheering and screaming and keeps only those numbers.
 *
 * - off:       not measuring.
 * - measuring: samples are being accepted by the backend.
 * - waiting:   measuring, but the backend has no active session for this channel yet
 *              (not on the watchlist, offline, or monitoring is off); samples are dropped.
 * - error:     measuring, but the last batch could not be delivered (backend unreachable).
 */
export type TabAudioStatus = "off" | "measuring" | "waiting" | "error";

export type AudioPlatform = "twitch" | "kick";

export interface TabAudioState {
  status: TabAudioStatus;
  tabId: number | null;
  platform: AudioPlatform | null;
  channel: string | null;
  startedAt: string | null;
  lastSentAt: string | null;
  /** Loudness of the latest second, dBFS. */
  levelDb: number | null;
  message: string | null;
  /** Sound detection (laughter, cheering, screaming) is on for this capture. */
  sounds: boolean;
  /** Backend's answer: receiving | not_installed | failed: … */
  soundState: string | null;
  /** Strongest value per kind in the latest batch (0–1). */
  heard: Partial<Record<SoundKind, number>> | null;
}

export interface PcmChunk {
  /** ISO time of the first sample (browser clock). */
  start: string;
  /** 16 kHz mono signed 16-bit little-endian samples, base64. */
  data: string;
}

export const INITIAL_TAB_AUDIO_STATE: TabAudioState = {
  status: "off",
  tabId: null,
  platform: null,
  channel: null,
  startedAt: null,
  lastSentAt: null,
  levelDb: null,
  message: null,
  sounds: false,
  soundState: null,
  heard: null,
};

export interface LoudnessSample {
  /** ISO time of the second (browser clock). */
  t: string;
  db: number;
}

const TWITCH_RESERVED = new Set([
  "directory", "videos", "settings", "search", "downloads", "p", "subscriptions", "inventory", "wallet", "drops",
  "turbo", "prime", "jobs", "store", "friends", "messages", "popout", "moderator", "u", "login", "signup", "following",
]);
const KICK_RESERVED = new Set([
  "categories", "browse", "following", "search", "dashboard", "settings", "video", "videos", "clips", "category",
  "login", "signup", "terms-of-service", "privacy-policy", "community-guidelines", "subscriptions", "messages",
]);

/** The channel shown in a Twitch/Kick tab, or null for any other page. */
export function channelFromUrl(url: string | undefined | null): { platform: AudioPlatform; channel: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
  const host = u.hostname.replace(/^(www|m)\./, "");
  if (host === "twitch.tv" && /^[A-Za-z0-9_]{2,25}$/.test(first) && !TWITCH_RESERVED.has(first.toLowerCase()))
    return { platform: "twitch", channel: first.toLowerCase() };
  if (host === "kick.com" && /^[A-Za-z0-9_-]{1,25}$/.test(first) && !KICK_RESERVED.has(first.toLowerCase()))
    return { platform: "kick", channel: first.toLowerCase() };
  return null;
}
