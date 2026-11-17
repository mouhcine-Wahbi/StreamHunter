import type { Platform } from "./api";

/**
 * Capture mode: the editor opens a stream tab and clicks Capture in the popup (Chrome requires that
 * click). The tab's video and audio are encoded in the browser into a rolling buffer (about the
 * last 2 minutes, in memory). Detected moments for that streamer, and "Save last 30 s", become
 * real MP4 clips stored in IndexedDB. Nothing is uploaded anywhere.
 */
export type CaptureStatus = "off" | "starting" | "capturing" | "error";

export interface CaptureState {
  status: CaptureStatus;
  tabId: number | null;
  platform: Platform | null;
  channel: string | null;
  streamerId: number | null;
  startedAt: string | null;
  /** Seconds of video currently in the buffer. */
  bufferedSeconds: number;
  clips: number;
  lastClipAt: string | null;
  levelDb: number | null;
  message: string | null;
}

export const INITIAL_CAPTURE_STATE: CaptureState = {
  status: "off",
  tabId: null,
  platform: null,
  channel: null,
  streamerId: null,
  startedAt: null,
  bufferedSeconds: 0,
  clips: 0,
  lastClipAt: null,
  levelDb: null,
  message: null,
};

export const CAPTURE_KEY = "sh.capture";

/** What the offscreen engine needs to know about the captured streamer. */
export interface CaptureTarget {
  streamerId: number;
  sessionId: number | null;
  platform: Platform;
  displayName: string;
  username: string;
  broadcastStartedAt: string | null;
}

export interface CaptureOptions {
  bufferSeconds: number;
  preRollSeconds: number;
  postRollSeconds: number;
  minScore: number;
}

/** A request to cut a clip: [start, end] in wall-clock ms, for an existing highlight. */
export interface ClipRequest {
  highlightId: number;
  start: number;
  end: number;
  title: string;
  score: number;
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
export function channelFromUrl(url: string | undefined | null): { platform: Platform; channel: string } | null {
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
