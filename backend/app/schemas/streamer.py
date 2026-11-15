from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.domain.enums import Platform
from app.schemas.common import Schema

# Twitch logins and Kick slugs: letters, digits, underscore (Kick slugs may contain - and .).
USERNAME_PATTERN = r"^[A-Za-z0-9_][A-Za-z0-9_.-]{1,24}$"


class StreamerSearchResult(BaseModel):
    platform: Platform
    platform_user_id: str
    username: str
    display_name: str
    profile_image_url: str | None
    is_live: bool | None
    current_title: str | None
    current_category: str | None


class StreamerCreate(BaseModel):
    platform: Platform
    username: str = Field(pattern=USERNAME_PATTERN)


class StreamerUpdate(BaseModel):
    monitoring_enabled: bool | None = None
    is_favorite: bool | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> StreamerUpdate:
        if self.monitoring_enabled is None and self.is_favorite is None:
            raise ValueError("Provide at least one of: monitoring_enabled, is_favorite")
        return self


class StreamerOut(Schema):
    """A streamer as seen by the requesting user (watchlist entry + channel data)."""

    id: int
    platform: Platform
    platform_user_id: str
    username: str
    display_name: str
    profile_image_url: str | None
    is_live: bool | None
    current_title: str | None
    current_category: str | None
    viewer_count: int | None
    stream_started_at: datetime | None
    status_checked_at: datetime | None
    monitoring_enabled: bool
    is_favorite: bool
    added_at: datetime
    updated_at: datetime


class StreamStatusOut(BaseModel):
    """Last known stream state. `last_checked_at` is null until monitoring has checked it."""

    streamer_id: int
    platform: Platform
    is_live: bool | None
    title: str | None
    category: str | None
    viewer_count: int | None
    started_at: datetime | None
    last_checked_at: datetime | None
