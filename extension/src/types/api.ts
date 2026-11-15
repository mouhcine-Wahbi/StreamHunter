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

export interface HighlightCandidate {
  id: number;
  streamer_id: number;
  streamer_display_name?: string;
  platform: Platform;
  timestamp: string;
  start_offset_sec: number | null;
  end_offset_sec: number | null;
  score: number;
  confidence: number;
  category: string;
  reasons: string[];
  signal_breakdown?: { chat?: number | null; audio?: number | null; visual?: number | null; context?: number | null };
  status: CandidateStatus;
}

export interface Clip {
  id: number;
  candidate_id: number;
  platform: Platform;
  platform_clip_id: string | null;
  platform_clip_url: string | null;
  local_file_path: string | null;
  title: string | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  status: CandidateStatus;
  error_message: string | null;
  created_at: string;
}
