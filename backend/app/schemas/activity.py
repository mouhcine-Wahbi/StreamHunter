"""Read models for monitoring sessions, events, highlights and clips."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import Field

from app.domain.enums import ClipStatus, MonitoringSessionStatus, Platform
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
    created_at: datetime
    updated_at: datetime


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
