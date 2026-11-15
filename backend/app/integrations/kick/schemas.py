"""Kick public API response models.

Endpoints and OAuth parameters are verified against KickEngineering/KickDevDocs
(2026-11-15). The per-field response schemas live only in Kick's OpenAPI spec
(https://api.kick.com/swagger/doc.yaml), which was NOT reachable from the dev container,
so the field names below are UNVERIFIED and parsed defensively: unknown fields are
ignored, identifiers accept int or str, and a missing required field raises an explicit
upstream error instead of producing guessed data. Confirm with the integration tests
(`pytest -m integration`) once credentials are available.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _parse_ts(v: object) -> datetime | None:
    if not v or not isinstance(v, str) or v.startswith("0001-01-01"):
        return None  # Go zero time is used for "never"
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def _id(v: object) -> str:
    if isinstance(v, bool) or not isinstance(v, int | str) or str(v) == "":
        raise ValueError("expected an id")
    return str(v)


class KickCategory(_M):
    id: int | str | None = None
    name: str | None = None


class KickStreamState(_M):
    is_live: bool | None = None
    viewer_count: int | None = None
    start_time: datetime | None = None

    @field_validator("start_time", mode="before")
    @classmethod
    def _ts(cls, v: object) -> datetime | None:
        return _parse_ts(v)


class KickChannel(_M):
    broadcaster_user_id: str
    slug: str
    stream_title: str | None = None
    category: KickCategory | None = None
    stream: KickStreamState | None = None

    @field_validator("broadcaster_user_id", mode="before")
    @classmethod
    def _uid(cls, v: object) -> str:
        return _id(v)


class KickUser(_M):
    user_id: str
    name: str | None = None
    profile_picture: str | None = None

    @field_validator("user_id", mode="before")
    @classmethod
    def _uid(cls, v: object) -> str:
        return _id(v)


class KickList[T](_M):
    data: list[T]


class KickTokenResponse(_M):
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: str | list[str] | None = None

    @field_validator("expires_in", mode="before")
    @classmethod
    def _int(cls, v: object) -> int | None:
        # The docs show expires_in as a string in examples; accept both.
        if v in (None, ""):
            return None
        try:
            return int(v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
