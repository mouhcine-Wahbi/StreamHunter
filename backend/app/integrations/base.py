"""Platform adapter contract.

The detection engine and services only talk to this interface, never to Twitch or Kick
directly. Every adapter reports *capabilities* derived from its real configuration and
the user's connection state, so the UI never promises something the platform can't do.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum

from app.domain.enums import ConnectionStatus, Platform


class CapabilityState(StrEnum):
    SUPPORTED = "supported"
    REQUIRES_CONFIGURATION = "requires_configuration"  # backend credentials / public URL missing
    REQUIRES_AUTHORIZATION = "requires_authorization"  # user must connect their account (OAuth)
    REQUIRES_MANUAL_ACTION = "requires_manual_action"  # no API; the editor does it on the platform
    CONDITIONAL = "conditional"  # depends on the channel/role (e.g. clips disabled, VOD exists)
    NOT_GUARANTEED = "not_guaranteed"
    NOT_IMPLEMENTED = "not_implemented"  # supported by the platform, not built yet in StreamHunter
    UNSUPPORTED = "unsupported"  # no official API exists


CAPABILITY_KEYS = (
    "stream_lookup",
    "live_detection",
    "category_lookup",
    "chat_monitoring",
    "official_clip_creation",
    "vod_analysis",
    "video_download",
)


@dataclass(frozen=True, slots=True)
class CapabilityReport:
    platform: Platform
    configured: bool
    connection_status: ConnectionStatus
    capabilities: dict[str, CapabilityState]
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ChannelInfo:
    """Normalized channel/profile data returned by an adapter."""

    platform: Platform
    platform_user_id: str
    username: str
    display_name: str
    profile_image_url: str | None
    is_live: bool | None
    current_title: str | None
    current_category: str | None


@dataclass(frozen=True, slots=True)
class LiveStatus:
    platform_user_id: str
    is_live: bool
    title: str | None
    category: str | None
    viewer_count: int | None
    started_at: datetime | None


@dataclass(frozen=True, slots=True)
class UserConnectionState:
    """What the adapter needs to know about the requesting user's platform connection."""

    status: ConnectionStatus = ConnectionStatus.NOT_CONNECTED
    scopes: frozenset[str] = frozenset()


class StreamingPlatform(ABC):
    platform: Platform

    @property
    @abstractmethod
    def configured(self) -> bool:
        """True when the backend has the credentials this adapter needs."""

    @abstractmethod
    def capabilities(self, connection: UserConnectionState) -> CapabilityReport: ...

    @abstractmethod
    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]: ...

    @abstractmethod
    async def get_channel(self, username: str) -> ChannelInfo | None: ...

    @abstractmethod
    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]: ...

    async def aclose(self) -> None:
        """Release network resources (HTTP clients, sockets)."""
        return None

    @property
    def oauth(self) -> OAuthProvider | None:
        """User authorization flow, or None when the platform/adapter has none."""
        return None


# --- User authorization (OAuth) -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenSet:
    access_token: str
    refresh_token: str | None
    expires_in: int | None
    scopes: frozenset[str]


@dataclass(frozen=True, slots=True)
class PlatformIdentity:
    platform_user_id: str
    username: str


class OAuthProvider(ABC):
    """Authorization-code flow for one platform. Client secrets stay on the backend."""

    scopes: tuple[str, ...]
    uses_pkce: bool

    @abstractmethod
    def authorization_url(self, *, state: str, code_challenge: str | None) -> str: ...

    @abstractmethod
    async def exchange_code(self, code: str, *, code_verifier: str | None) -> TokenSet: ...

    @abstractmethod
    async def refresh(self, refresh_token: str) -> TokenSet: ...

    @abstractmethod
    async def identify(self, access_token: str) -> PlatformIdentity: ...

    @abstractmethod
    async def revoke(self, token: str) -> None:
        """Best effort; must not raise for an already-invalid token."""
