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

    streamer: Mapped[Streamer] = relationship(lazy="joined")


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
