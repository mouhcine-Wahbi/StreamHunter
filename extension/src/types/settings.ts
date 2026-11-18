export type Sensitivity = "low" | "medium" | "high";

export const SUPPORTED_KEYWORD_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "ar", label: "العربية" },
  { code: "tr", label: "Türkçe" },
] as const;

export interface Settings {
  monitoring: {
    /** Live-status check interval in minutes (Chrome alarms enforce >= 30 s). */
    intervalMinutes: number;
    /** Resume monitoring automatically when Chrome starts, if it was on before. */
    resumeOnStartup: boolean;
  };
  detection: {
    sensitivity: Sensitivity;
    /** Candidates below this score (0–100) are hidden from review queues. */
    minHighlightScore: number;
    /** Languages whose reaction keyword packs are enabled. */
    keywordLanguages: string[];
    /** Extra user-defined phrases that indicate a highlight ("clip it", "W", ...). */
    customKeywords: string[];
    /** Signal fusion: points each kind of signal adds at full strength, plus the multi-signal bonus. */
    weights: { audio: number; chat: number; visual: number; viewers: number; multi: number };
    /** Minimum fused score (0–100) for an automatic clip. */
    clipThreshold: number;
  };
  clips: {
    /** Seconds included before the detected moment. */
    preRollSeconds: number;
    /** Seconds included after the detected moment. */
    postRollSeconds: number;
    /** Rolling buffer kept in memory while recording (seconds). */
    bufferSeconds: number;
    /** A clip never grows longer than this when moments overlap (seconds). */
    maxClipSeconds: number;
    /** Also create a clip on Twitch itself (needs Sign in with Twitch with the clips:edit permission). */
    twitchNativeClips: boolean;
  };
  storage: {
    /** Clips are deleted, oldest first (favourites never), when they take more than this (MB). */
    maxTotalMb: number;
    /** Clips older than this are deleted (favourites never); 0 = keep. */
    maxAgeDays: number;
  };
  notifications: {
    onHighlight: boolean;
    onStreamerLive: boolean;
  };
  locale: {
    /** IANA time zone, or "auto" for the browser's zone. */
    timeZone: string;
    language: string;
  };
  privacy: {
    /** Days to keep provisional highlights and ended sessions. Chat messages are never kept; clips stay until deleted. */
    retentionDays: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  monitoring: { intervalMinutes: 2, resumeOnStartup: true },
  detection: {
    sensitivity: "medium",
    minHighlightScore: 60,
    keywordLanguages: ["en"],
    customKeywords: [],
    weights: { audio: 25, chat: 30, visual: 20, viewers: 15, multi: 10 },
    clipThreshold: 40,
  },
  clips: { preRollSeconds: 20, postRollSeconds: 20, bufferSeconds: 120, maxClipSeconds: 90, twitchNativeClips: false },
  storage: { maxTotalMb: 5120, maxAgeDays: 0 },
  notifications: { onHighlight: true, onStreamerLive: false },
  locale: { timeZone: "auto", language: "en" },
  privacy: { retentionDays: 30 },
};

export const LIMITS = {
  intervalMinutes: { min: 1, max: 60 },
  minHighlightScore: { min: 0, max: 100 },
  rollSeconds: { min: 0, max: 120 },
  retentionDays: { min: 1, max: 365 },
  weight: { min: 0, max: 100 },
  bufferSeconds: { min: 60, max: 300 },
  maxClipSeconds: { min: 30, max: 180 },
  maxTotalMb: { min: 200, max: 102_400 },
  maxAgeDays: { min: 0, max: 365 },
  customKeywords: { maxItems: 50, maxLength: 40 },
} as const;

/** Deep-partial helper used for settings patches. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
