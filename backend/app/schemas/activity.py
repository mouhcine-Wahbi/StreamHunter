"""Read models for monitoring sessions, events, highlights and clips."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from typing import Literal

from pydantic import Field, HttpUrl

from app.domain.enums import ClipStatus, HighlightCategory, MonitoringSessionStatus, Platform
from app.schemas.common import Schema


class MonitoringSessionOut(Schema):
    id: int
    streamer_id: int
    streamer_display_name: str | None = None
    platform: Platform
    started_at: datetime
    ended_at: datetime | None
    status: MonitoringSessionStatus
    last_checked_at: datetime | None
    last_event_at: datetime | None
    error_message: str | None
    broadcast_started_at: datetime | None = None
    vod_id: str | None = None
    vod_url: str | None = None


class StreamEventOut(Schema):
    id: int
    session_id: int
    streamer_id: int
    event_type: str
    platform_timestamp: datetime | None
    stream_offset_sec: float | None
    confidence: float
    metadata: dict[str, Any] = Field(validation_alias="event_metadata")
    created_at: datetime


class HighlightOut(Schema):
    id: int
    session_id: int
    streamer_id: int
    streamer_display_name: str | None = None
    streamer_username: str | None = None
    platform: Platform
    timestamp: datetime
    start_offset_sec: float | None
    end_offset_sec: float | None
    score: float
    confidence: float
    category: str
    reasons: list[str]
    signal_breakdown: dict[str, Any]
    status: ClipStatus
    origin: str = "chat"
    created_at: datetime
    updated_at: datetime
    clip: ClipSummary | None = None
    vod_url_at: str | None = None  # the platform VOD at this moment (approximate)


class ClipOut(Schema):
    id: int
    candidate_id: int
    platform: Platform
    platform_clip_id: str | None
    platform_clip_url: str | None
    local_file_path: str | None
    title: str | None
    duration_seconds: int | None
    aspect_ratio: str | None
    status: ClipStatus
    error_message: str | None
    source: str
    edit_url: str | None
    requested_at: datetime | None
    request_lag_seconds: float | None
    published_at: datetime | None
    published_url: str | None
    created_at: datetime
    updated_at: datetime


class HeartbeatRequest(Schema):
    client: str = Field("chrome-extension", min_length=1, max_length=64)
    interval_seconds: int = Field(120, ge=30, le=3600)
    # Return notifications for events after this time (the client's previous heartbeat).
    since: datetime | None = None


class NotificationOut(Schema):
    type: str  # streamer_live | streamer_offline | highlight_detected
    streamer_id: int
    streamer_display_name: str
    platform: Platform
    title: str | None
    category: str | None
    at: datetime
    highlight_id: int | None = None
    score: float | None = None


class HeartbeatOut(Schema):
    lease_expires_at: datetime
    interval_seconds: int
    started: bool
    active_sessions: int
    live_count: int
    notifications: list[NotificationOut]
    server_time: datetime


class MonitoringStatusOut(Schema):
    lease_active: bool
    lease_expires_at: datetime | None
    last_heartbeat_at: datetime | None
    active_sessions: int
    paused_sessions: int
    scheduler_running: bool
    last_cycle_at: datetime | None


class ClipSummary(Schema):
    id: int
    status: ClipStatus
    platform_clip_url: str | None
    error_message: str | None


class HighlightPatch(Schema):
    model_config = {"extra": "forbid"}
    status: Literal["pending_review"] | None = None  # reopen a rejected highlight
    start_offset_sec: float | None = Field(None, ge=0)
    end_offset_sec: float | None = Field(None, ge=0)
    category: HighlightCategory | None = None


class ReviewOut(Schema):
    highlight: HighlightOut
    clip: ClipOut | None


class ClipCreateRequest(Schema):
    # Twitch clips the broadcast at request time; required to clip a moment older than ~90 s.
    accept_current_moment: bool = False


class ClipPatch(Schema):
    model_config = {"extra": "forbid"}
    title: str | None = Field(None, max_length=140)
    aspect_ratio: Literal["16:9", "9:16", "1:1"] | None = None
    # Manual workflow (Kick): link to the clip the editor made on the platform.
    platform_clip_url: str | None = Field(None, max_length=500)


class PublishRequest(Schema):
    model_config = {"extra": "forbid"}
    confirm: Literal[True]  # publishing is never implicit
    published_url: HttpUrl | None = None


HighlightOut.model_rebuild()
ReviewOut.model_rebuild()
