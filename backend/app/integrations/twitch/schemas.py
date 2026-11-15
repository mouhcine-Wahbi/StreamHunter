"""Helix response models. Unknown fields are ignored; required fields are validated.

Field sources:
  * Get Users / Get Streams: twitchdev/twitch-cli mock API models (official), checked 2026-11-15.
  * Search Channels and OAuth responses: Twitch API reference (not reachable from the dev
    container this session); treated as unverified and parsed defensively.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _parse_ts(v: object) -> datetime | None:
    if not v or not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


class HelixUser(_M):
    id: str
    login: str
    display_name: str
    profile_image_url: str | None = None


class HelixStream(_M):
    user_id: str
    user_login: str | None = None
    type: str = ""
    title: str | None = None
    game_name: str | None = None
    viewer_count: int | None = None
    started_at: datetime | None = None

    @field_validator("started_at", mode="before")
    @classmethod
    def _ts(cls, v: object) -> datetime | None:
        return _parse_ts(v)


class HelixSearchChannel(_M):
    id: str
    broadcaster_login: str
    display_name: str
    is_live: bool | None = None
    title: str | None = None
    game_name: str | None = None
    thumbnail_url: str | None = None  # the channel's profile image
    started_at: datetime | None = None

    @field_validator("started_at", mode="before")
    @classmethod
    def _ts(cls, v: object) -> datetime | None:
        return _parse_ts(v)


class HelixList[T](_M):
    data: list[T]


class TwitchTokenResponse(_M):
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: list[str] | str | None = None


class TwitchValidateResponse(_M):
    client_id: str
    login: str | None = None
    user_id: str | None = None
    scopes: list[str] | None = None
    expires_in: int | None = None
