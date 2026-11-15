from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin
from app.db.types import UTCDateTime, utcnow
from app.models.streamer import Streamer


class MonitoringSession(Base):
    __tablename__ = "monitoring_sessions"
    __table_args__ = (
        Index("ix_monitoring_sessions_user_status", "user_id", "status"),
        Index("ix_monitoring_sessions_streamer", "streamer_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    streamer_id: Mapped[int] = mapped_column(ForeignKey("streamers.id", ondelete="CASCADE"), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_event_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Platform-reported start of the broadcast this session covers. Lets a paused session be
    # resumed only for the *same* broadcast, and is the base for stream offsets (approximate).
    broadcast_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    streamer: Mapped[Streamer] = relationship(lazy="joined")


class MonitoringLease(TimestampMixin, Base):
    """Browser-based monitoring: valid only while the extension keeps sending heartbeats.

    When `expires_at` passes (browser closed, laptop asleep, extension disabled) the backend
    stops polling for this user and pauses their sessions. It never monitors on its own.
    """

    __tablename__ = "monitoring_leases"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    client: Mapped[str] = mapped_column(String(64), nullable=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_heartbeat_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    def is_active(self, now: datetime) -> bool:
        return self.released_at is None and self.expires_at > now


class StreamEvent(CreatedAtMixin, Base):
    """A detector output. Holds aggregated metrics only — never raw chat messages."""

    __tablename__ = "stream_events"
    __table_args__ = (
        Index("ix_stream_events_session_created", "session_id", "created_at"),
        Index("ix_stream_events_streamer", "streamer_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("monitoring_sessions.id", ondelete="CASCADE"), nullable=False)
    streamer_id: Mapped[int] = mapped_column(ForeignKey("streamers.id", ondelete="CASCADE"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    platform_timestamp: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    stream_offset_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    # `metadata` is reserved by SQLAlchemy's declarative API, so the attribute is renamed.
    event_metadata: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class HighlightCandidate(TimestampMixin, Base):
    __tablename__ = "highlight_candidates"
    __table_args__ = (
        Index("ix_highlight_candidates_user_ts", "user_id", "timestamp"),
        Index("ix_highlight_candidates_user_status", "user_id", "status"),
        Index("ix_highlight_candidates_streamer", "streamer_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Denormalized owner (also reachable via session) so every query can be scoped cheaply.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[int] = mapped_column(ForeignKey("monitoring_sessions.id", ondelete="CASCADE"), nullable=False)
    streamer_id: Mapped[int] = mapped_column(ForeignKey("streamers.id", ondelete="CASCADE"), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    start_offset_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_offset_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    category: Mapped[str] = mapped_column(String(48), nullable=False, default="unknown")
    reasons: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    signal_breakdown: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending_review")

    streamer: Mapped[Streamer] = relationship(lazy="joined")


class Clip(TimestampMixin, Base):
    __tablename__ = "clips"
    __table_args__ = (
        Index("ix_clips_user_created", "user_id", "created_at"),
        Index("ix_clips_candidate", "candidate_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("highlight_candidates.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    platform_clip_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    platform_clip_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    aspect_ratio: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # How the platform clip came to be: auto (captured at detection), editor (requested from the
    # review screen) or manual (editor made it on the platform and pasted the URL).
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="editor", server_default="editor")
    edit_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # Twitch clip editor link
    requested_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Seconds between the detected peak and the clip request (Twitch clips the broadcast *now*).
    request_lag_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    published_url: Mapped[str | None] = mapped_column(Text, nullable=True)
