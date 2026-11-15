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
