/**
 * Response shapes of the StreamHunter backend (/api/v1). They mirror the Pydantic
 * schemas defined in backend/app/schemas and API_DOCUMENTATION.md.
 */
export type Platform = "twitch" | "kick";

export const PLATFORMS: readonly { id: Platform; label: string }[] = [
  { id: "twitch", label: "Twitch" },
  { id: "kick", label: "Kick" },
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
  origin?: "chat" | "vod" | "merged";
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
    /** Post-stream sound classification: highest probability (0–1) of each kind of sound in the window. */
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

export interface MediaSource {
  id: number;
  session_id: number | null;
  kind: "upload" | "registered";
  original_name: string;
  size_bytes: number;
  duration_sec: number | null;
  has_audio: boolean;
  has_video: boolean;
  width: number | null;
  height: number | null;
  offset_in_stream_sec: number;
  status: string;
  error_message: string | null;
  created_at: string;
}

export interface MediaJob {
  id: number;
  kind: "analyze" | "export";
  media_source_id: number;
  clip_id: number | null;
  status: "queued" | "running" | "succeeded" | "failed";
  result: Record<string, unknown>;
  error_message: string | null;
}

export interface MediaCapabilities {
  ffmpeg_available: boolean;
  max_upload_mb: number;
  media_folder: string;
  supported_extensions: string[];
  /** "supported" when the backend has FFmpeg and local speech recognition. */
  subtitles: string;
  /** "supported" when the backend can hear laughter, cheering and screaming in recordings. */
  sound_events: string;
  live_tab_audio: string;
}
