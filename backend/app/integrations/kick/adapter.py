"""Kick adapter (Kick public API + OAuth with PKCE).

Verified constraints (KickEngineering/KickDevDocs, see ARCHITECTURE.md §3):
  * there is no documented channel *search* endpoint → "search" is an exact slug lookup;
  * chat is only delivered via webhooks to a public HTTPS URL (Phase 5);
  * there is no official clip-creation API and no VOD/media API.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.domain.enums import Platform
from app.errors import PlatformUnavailableError
from app.integrations.base import (
    CapabilityReport,
    CapabilityState,
    ChannelInfo,
    LiveStatus,
    OAuthProvider,
    StreamingPlatform,
    UserConnectionState,
)
from app.integrations.capabilities import api_capability
from app.integrations.http import make_client
from app.integrations.kick.auth import KickOAuth
from app.integrations.kick.client import KickApiClient
from app.integrations.kick.schemas import KickChannel

IMPLEMENTED: frozenset[str] = frozenset({"stream_lookup", "live_detection", "category_lookup", "chat_monitoring"})


class KickAdapter(StreamingPlatform):
    platform = Platform.KICK

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._client_id = settings.kick_client_id
        secret = settings.kick_client_secret.get_secret_value() if settings.kick_client_secret else ""
        self._has_secret = bool(secret)
        self._webhook_url = settings.kick_webhook_public_url
        self._http = make_client(transport=transport)
        self._api: KickApiClient | None = None
        self._oauth: KickOAuth | None = None
        if self.configured:
            assert self._client_id
            self._api = KickApiClient(self._client_id, secret, self._http)
            self._oauth = KickOAuth(self._client_id, secret, settings.kick_redirect_uri, self._http, self._api)

    @property
    def configured(self) -> bool:
        return bool(self._client_id) and self._has_secret

    @property
    def oauth(self) -> OAuthProvider | None:
        return self._oauth

    @property
    def api(self) -> KickApiClient | None:
        return self._api

    @property
    def webhook_configured(self) -> bool:
        return self.configured and bool(self._webhook_url)

    def capabilities(self, connection: UserConnectionState) -> CapabilityReport:
        cfg = self.configured
        if not cfg or not self._webhook_url:
            chat = CapabilityState.REQUIRES_CONFIGURATION
        else:
            chat = CapabilityState.SUPPORTED if "chat_monitoring" in IMPLEMENTED else CapabilityState.NOT_IMPLEMENTED
        caps = {
            "stream_lookup": api_capability(configured=cfg, implemented="stream_lookup" in IMPLEMENTED),
            "live_detection": api_capability(configured=cfg, implemented="live_detection" in IMPLEMENTED),
            "category_lookup": api_capability(configured=cfg, implemented="category_lookup" in IMPLEMENTED),
            "chat_monitoring": chat,
            "official_clip_creation": CapabilityState.REQUIRES_MANUAL_ACTION,
            "vod_analysis": CapabilityState.UNSUPPORTED,
            "video_download": CapabilityState.UNSUPPORTED,
        }
        notes = []
        if not cfg:
            notes.append("Set KICK_CLIENT_ID and KICK_CLIENT_SECRET on the backend.")
        notes.append("Kick has no search API: enter the exact channel name (the part after kick.com/).")
        if not self._webhook_url:
            notes.append("Kick chat needs a public HTTPS webhook URL (KICK_WEBHOOK_PUBLIC_URL), e.g. a tunnel.")
        notes.append("Kick has no official clip API: clips are created manually on Kick.")
        return CapabilityReport(
            platform=self.platform, configured=cfg, connection_status=connection.status, capabilities=caps, notes=notes
        )

    def _client(self) -> KickApiClient:
        if self._api is None:
            raise PlatformUnavailableError(
                "Kick is not configured on the backend (KICK_CLIENT_ID / KICK_CLIENT_SECRET).",
                code="platform_not_configured",
                details={"platform": "kick"},
            )
        return self._api

    async def _to_info(self, channels: list[KickChannel]) -> list[ChannelInfo]:
        api = self._client()
        users = {u.user_id: u for u in await api.users([c.broadcaster_user_id for c in channels])} if channels else {}
        out = []
        for c in channels:
            u = users.get(c.broadcaster_user_id)
            is_live = c.stream.is_live if c.stream else None
            out.append(
                ChannelInfo(
                    platform=self.platform,
                    platform_user_id=c.broadcaster_user_id,
                    username=c.slug,
                    display_name=(u.name if u and u.name else c.slug),
                    profile_image_url=(u.profile_picture or None) if u else None,
                    is_live=is_live,
                    current_title=(c.stream_title or None) if is_live else None,
                    current_category=(c.category.name if c.category else None) if is_live else None,
                )
            )
        return out

    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]:
        # No official search: an exact slug lookup is the most we can honestly offer.
        channels = await self._client().channels_by_slug(query.lower())
        return (await self._to_info(channels))[:limit]

    async def get_channel(self, username: str) -> ChannelInfo | None:
        channels = await self._client().channels_by_slug(username.lower())
        infos = await self._to_info(channels[:1])
        return infos[0] if infos else None

    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]:
        ids = list(dict.fromkeys(platform_user_ids))
        if not ids:
            return {}
        channels = {c.broadcaster_user_id: c for c in await self._client().channels_by_ids(ids)}
        out: dict[str, LiveStatus] = {}
        for uid in ids:
            c = channels.get(uid)
            if c is None or c.stream is None or c.stream.is_live is None:
                continue  # unknown: never report a guessed status
            live = c.stream.is_live
            out[uid] = LiveStatus(
                platform_user_id=uid,
                is_live=live,
                title=(c.stream_title or None) if live else None,
                category=(c.category.name if c.category else None) if live else None,
                viewer_count=c.stream.viewer_count if live else None,
                started_at=c.stream.start_time if live else None,
            )
        return out

    async def aclose(self) -> None:
        await self._http.aclose()
