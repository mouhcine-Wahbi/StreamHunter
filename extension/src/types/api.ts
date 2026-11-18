/**
 * StreamHunter's data model (stored in IndexedDB, served by LocalApi under /api/v1/... paths).
 */
export type Platform = "twitch" | "kick" | "youtube";
export const PLATFORM_LABEL: Record<Platform, string> = { twitch: "Twitch", kick: "Kick", youtube: "YouTube" };

export const PLATFORMS: readonly { id: Platform; label: string }[] = [
  { id: "twitch", label: "Twitch" },
  { id: "kick", label: "Kick" },
  { id: "youtube", label: "YouTube" },
];

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface StreamerSearchResult {
  platform: Platform;
  platform_user_id: string;
  username: string;
  display_name: string;
  profile_image_url: string | null;
  is_live: boolean | null;
  current_title: string | null;
  current_category: string | null;
}

export interface Streamer extends StreamerSearchResult {
  id: number;
  viewer_count: number | null;
  stream_started_at: string | null;
  status_checked_at: string | null;
  monitoring_enabled: boolean;
  is_favorite: boolean;
  /** Recorder mode records this streamer automatically while live. */
  auto_record?: boolean;
  updated_at: string;
}

export type MonitoringSessionStatus = "active" | "paused" | "ended" | "error";

export interface MonitoringSession {
  id: number;
  streamer_id: number;
  streamer_display_name: string | null;
  broadcast_started_at: string | null;
  vod_id?: string | null;
  vod_url?: string | null;
  platform: Platform;
  started_at: string;
  ended_at: string | null;
  status: MonitoringSessionStatus;
  last_checked_at: string | null;
  last_event_at: string | null;
  error_message: string | null;
}

export type CandidateStatus =
  | "detected"
  | "pending_review"
  | "approved"
  | "rejected"
  | "creation_requested"
  | "created"
  | "exporting"
  | "ready"
  | "failed"
  | "published"
  | "unsupported";

export interface ClipSummary {
  id: number;
  status: CandidateStatus;
  platform_clip_url: string | null;
  error_message: string | null;
}

export interface HighlightCandidate {
  id: number;
  streamer_id: number;
  streamer_display_name?: string;
  streamer_username?: string | null;
  clip?: ClipSummary | null;
  origin?: "chat" | "viewers" | "capture" | "vod" | "merged";
  vod_url_at?: string | null;
  platform: Platform;
  timestamp: string;
  start_offset_sec: number | null;
  end_offset_sec: number | null;
  score: number;
  confidence: number;
  category: string;
  reasons: string[];
  signal_breakdown?: {
    chat?: number | null;
    audio?: number | null;
    visual?: number | null;
    context?: number | null;
    /** Post-stream sound classification: strongest value (0–1, summed over related model classes) of each kind of sound in the window. */
    sounds?: Partial<Record<SoundKind, number>> | null;
  };
  status: CandidateStatus;
}

export type SoundKind = "laughter" | "cheering" | "screaming";

export interface Clip {
  id: number;
  candidate_id: number;
  platform: Platform;
  platform_clip_id: string | null;
  platform_clip_url: string | null;
  local_file_path: string | null;
  /** .srt next to the export when it was made with subtitles. */
  subtitles_file_path: string | null;
  title: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  status: CandidateStatus;
  error_message: string | null;
  source: "auto" | "editor" | "manual";
  edit_url: string | null;
  requested_at: string | null;
  request_lag_seconds: number | null;
  published_at: string | null;
  published_url: string | null;
  created_at: string;
}
