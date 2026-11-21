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
  scheduler: {
    /** Priority weights (any scale; shown as percentages). */
    weights: { potential: number; activity: number; growth: number; user: number; reliability: number };
    /** A recording is never replaced before it has run this long. */
    minRecordMinutes: number;
    /** A slot doesn't switch streamer again within this time. */
    cooldownMinutes: number;
    /** A waiting streamer must score this many points more to replace a recording. */
    switchMargin: number;
    /** Failed recordings of a broadcast are retried this many times (2, 5, 15 min apart). */
    maxRetries: number;
  };
  recording: {
    /** How many streams may be recorded at the same time (one recorder tab each). */
    maxStreams: number;
    /** 720p30 at 3 Mbit/s, or 480p30 at 1.5 Mbit/s (lighter on CPU, RAM and storage). */
    quality: "720p" | "480p";
    /** Whose sound plays through the speakers: the first recorded stream, or none (recording is unaffected). */
    audio: "first" | "none";
    /** Lower frame rate, then pause the lowest-priority stream, when the Mac is overloaded. */
    protectResources: boolean;
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
    /** Desktop notification when a selected streamer goes live and needs your recording approval. */
    approvalRequests: boolean;
    /** "Remind me later" asks again after this many minutes (same broadcast only). */
    remindMinutes: number;
  };
  /** 3.0 content discovery. */
  discovery: {
    enabled: boolean;
    /** Automatic runs every N hours while Chrome is open; 0 = only when you click Run. */
    intervalHours: number;
    youtubeRegion: string;
    /** YouTube category IDs for trending ("20" = Gaming); "" = all. */
    youtubeCategories: string[];
    twitchTrending: boolean;
    /** Twitch: most-viewed clips of this many top categories. */
    twitchTopGames: number;
    /** Topics, gaming categories or creator names. */
    keywords: string[];
    /** Keyword search on YouTube costs 100 of 10,000 daily units per keyword. */
    keywordYouTube: boolean;
    language: string;
    maxAgeDays: number;
    minViews: number;
    minEngagementPct: number;
    perSourceMax: number;
  };
  /** 3.0 output formats. */
  formats: {
    vertical: boolean;
    landscape: boolean;
    /** Default vertical layout (each creator and clip can override). */
    verticalLayout: "facecam_top" | "action" | "center";
  };
  /** 3.0 viral-potential score (estimated, never a guarantee). */
  scoring: {
    weights: { hook: number; emotion: number; engagement: number; story: number; share: number; platform: number };
    /** High potential: auto-publish when every check passes. */
    publishThreshold: number;
    /** Medium potential (≥ this, below publishThreshold): needs your approval. Below: low, manual review only. */
    reviewThreshold: number;
  };
  /** 3.0 publishing. */
  publishing: {
    autoPublish: boolean;
    destinations: Record<"youtube" | "tiktok" | "x", { enabled: boolean; dailyLimit: number }>;
    youtubePrivacy: "private" | "unlisted" | "public";
    /** Adds "Credit: <creator> on <platform>" with the source link to every description. */
    attribution: boolean;
    maxRetries: number;
  };
  /** 3.0 metadata generation: on-device AI → your provider → templates. */
  ai: {
    onDevice: boolean;
    external: "none" | "anthropic" | "openai_compatible";
    model: string;
    /** openai_compatible only: base URL (e.g. http://localhost:11434/v1 for a local model). */
    endpoint: string;
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
  scheduler: { weights: { potential: 45, activity: 20, growth: 15, user: 15, reliability: 5 }, minRecordMinutes: 10, cooldownMinutes: 5, switchMargin: 12, maxRetries: 3 },
  recording: { maxStreams: 3, quality: "720p", audio: "first", protectResources: true },
  storage: { maxTotalMb: 5120, maxAgeDays: 0 },
  notifications: { onHighlight: true, onStreamerLive: false, approvalRequests: true, remindMinutes: 10 },
  discovery: {
    enabled: true, intervalHours: 6, youtubeRegion: "US", youtubeCategories: ["20"], twitchTrending: true, twitchTopGames: 3,
    keywords: [], keywordYouTube: false, language: "", maxAgeDays: 7, minViews: 0, minEngagementPct: 0, perSourceMax: 20,
  },
  formats: { vertical: true, landscape: true, verticalLayout: "facecam_top" },
  scoring: { weights: { hook: 25, emotion: 20, engagement: 20, story: 15, share: 10, platform: 10 }, publishThreshold: 85, reviewThreshold: 60 },
  publishing: {
    autoPublish: true,
    destinations: { youtube: { enabled: true, dailyLimit: 5 }, tiktok: { enabled: true, dailyLimit: 10 }, x: { enabled: true, dailyLimit: 20 } },
    youtubePrivacy: "public", attribution: true, maxRetries: 3,
  },
  ai: { onDevice: true, external: "none", model: "", endpoint: "" },
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
  maxStreams: { min: 1, max: 8 },
  minRecordMinutes: { min: 0, max: 120 },
  cooldownMinutes: { min: 0, max: 60 },
  switchMargin: { min: 0, max: 100 },
  maxRetries: { min: 0, max: 10 },
  customKeywords: { maxItems: 50, maxLength: 40 },
} as const;

/** Deep-partial helper used for settings patches. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
