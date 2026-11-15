from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAtMixin, TimestampMixin
from app.db.types import UTCDateTime


class Streamer(TimestampMixin, Base):
    """A channel on a platform. Shared between users; per-user state lives in UserStreamer."""

    __tablename__ = "streamers"
    __table_args__ = (
        UniqueConstraint("platform", "platform_user_id"),
        Index("ix_streamers_platform_username", "platform", "username"),
        Index("ix_streamers_is_live", "is_live"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    platform_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    profile_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # None = never checked. Last known values; refreshed by monitoring (Phase 4).
    is_live: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    current_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_category: Mapped[str | None] = mapped_column(String(255), nullable=True)
    viewer_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stream_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    status_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Aggregate: true when at least one user monitors this streamer (kept in sync by the service).
    monitoring_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    followers: Mapped[list[UserStreamer]] = relationship(back_populates="streamer", cascade="all, delete-orphan")


class UserStreamer(CreatedAtMixin, Base):
    """A streamer on a user's watchlist."""

    __tablename__ = "user_streamers"
    __table_args__ = (UniqueConstraint("user_id", "streamer_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    streamer_id: Mapped[int] = mapped_column(ForeignKey("streamers.id", ondelete="CASCADE"), nullable=False, index=True)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    monitoring_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    streamer: Mapped[Streamer] = relationship(back_populates="followers", lazy="joined")
