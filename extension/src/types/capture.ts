import type { Platform } from "./api";

/**
 * Capture mode: the editor opens a stream tab and clicks Capture in the popup (Chrome requires that
 * click). The tab's video and audio are encoded in the browser into a rolling buffer (about the
 * last 2 minutes, in memory). Detected moments for that streamer, and "Save last 30 s", become
 * real MP4 clips stored in IndexedDB. Nothing is uploaded anywhere.
 */
export type CaptureStatus = "off" | "starting" | "capturing" | "error";

/**
 * manual:   the editor captures the stream open in a tab (popup → Capture this stream).
 * recorder: automatic. The editor armed one tab once; StreamHunter navigates it to whichever
 *           "Auto-record" streamer is live and records only while one is.
 */
export type CaptureMode = "manual" | "recorder";

/** Why a slot is paused: by the editor, by Pause monitoring, or by overload/storage protection. */
export type PauseReason = "you" | "monitoring" | "overload" | "storage";

/** Encoder health of one slot (from the engine, every 3 s). */
export interface SlotHealth {
  /** Encoded video frames per second over the last report. */
  fps: number;
  /** Frames dropped because the encoder was behind, since the slot started. */
  dropped: number;
  /** Encoder queue at the last report. */
  queue: number;
  /** Recording at half frame rate to save CPU (overload protection). */
  throttled: boolean;
}

/**
 * One recording slot = one captured tab with its own engine, buffer, detection and clips.
 * Several slots can run at once (Settings → Recording → simultaneous streams).
 */
export interface CaptureState {
  status: CaptureStatus;
  mode: CaptureMode;
  pauseReason: PauseReason | null;
  /** This slot's sound plays through the speakers. */
  listening: boolean;
  health: SlotHealth | null;
  /** When the slot was armed/started (ordering). */
  armedAt: string | null;
  /** Encoding into the buffer right now (false while the recorder waits for a streamer or is paused). */
  recording: boolean;
  paused: boolean;
  /** Recorder mode: why nothing is being recorded right now. */
  waitingReason: string | null;
  /** Seconds the captured audio has been silent (muted player?). */
  silentSeconds: number;
  /** Seconds recorded by this capture. */
  recordedSeconds: number;
  /** Latest automatic detection (any signal, clipped or not). */
  lastDetection: { at: string; reasons: string[]; score: number; clipped: boolean } | null;
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
  mode: "manual",
  pauseReason: null,
  listening: false,
  health: null,
  armedAt: null,
  recording: false,
  paused: false,
  waitingReason: null,
  silentSeconds: 0,
  recordedSeconds: 0,
  lastDetection: null,
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

/** Legacy single-slot key (v1.1); replaced by CAPTURES_KEY. */
export const CAPTURE_KEY = "sh.capture";
/** All recording slots: { [tabId]: CaptureState }. */
export const CAPTURES_KEY = "sh.captures";
/** Machine and storage load as last measured (overload protection). */
export const SYSTEM_KEY = "sh.system";

export interface SystemLoad {
  at: string;
  /** Whole-machine CPU use, 0–100 (null when Chrome can't tell). */
  cpuPercent: number | null;
  memAvailableBytes: number | null;
  memCapacityBytes: number | null;
  storageUsedBytes: number | null;
  storageQuotaBytes: number | null;
  /** New slots are refused and streams are throttled/paused while true. */
  overloaded: boolean;
  reason: string | null;
  /** What the protection did last ("Lowered alpha to 15 fps", …). */
  lastAction: string | null;
}
/** Lifetime totals: { recordedSeconds } (shown on the Overview). */
export const STATS_KEY = "sh.stats";

/** What the offscreen engine needs to know about the captured streamer. */
export interface CaptureTarget {
  streamerId: number;
  sessionId: number | null;
  platform: Platform;
  displayName: string;
  username: string;
  broadcastStartedAt: string | null;
  category?: string | null;
}

export type RecordingQuality = "720p" | "480p";

export interface CaptureOptions {
  quality?: RecordingQuality;
  /** Play this slot's sound through the speakers. */
  listen?: boolean;
  bufferSeconds: number;
  preRollSeconds: number;
  postRollSeconds: number;
  maxClipSeconds: number;
  /** Fusion: weights per signal kind and the minimum fused score for a clip. */
  weights: { audio: number; chat: number; visual: number; viewers: number; multi: number };
  clipThreshold: number;
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
