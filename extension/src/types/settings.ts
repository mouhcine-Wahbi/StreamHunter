export type Sensitivity = "low" | "medium" | "high";
export type AspectRatio = "16:9" | "9:16" | "1:1";

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
  /** Base URL of the StreamHunter backend, without trailing slash. */
  backendUrl: string;
  monitoring: {
    /** Heartbeat / status poll interval in minutes (Chrome alarms enforce >= 30 s). */
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
  };
  clips: {
    /** Seconds included before the detected moment. */
    preRollSeconds: number;
    /** Seconds included after the detected moment. */
    postRollSeconds: number;
    defaultAspectRatio: AspectRatio;
    /** Request the official Twitch clip as soon as a highlight is detected (it is not published). */
    autoCreatePlatformClips: boolean;
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
    /** Days to keep aggregated chat statistics and events. Raw messages are never kept. */
    retentionDays: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: "http://localhost:8000",
  monitoring: { intervalMinutes: 2, resumeOnStartup: true },
  detection: {
    sensitivity: "medium",
    minHighlightScore: 60,
    keywordLanguages: ["en"],
    customKeywords: [],
  },
  clips: { preRollSeconds: 20, postRollSeconds: 10, defaultAspectRatio: "9:16", autoCreatePlatformClips: true },
  notifications: { onHighlight: true, onStreamerLive: false },
  locale: { timeZone: "auto", language: "en" },
  privacy: { retentionDays: 30 },
};

export const LIMITS = {
  intervalMinutes: { min: 1, max: 60 },
  minHighlightScore: { min: 0, max: 100 },
  rollSeconds: { min: 0, max: 120 },
  retentionDays: { min: 1, max: 365 },
  customKeywords: { maxItems: 50, maxLength: 40 },
} as const;

/** Deep-partial helper used for settings patches. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
