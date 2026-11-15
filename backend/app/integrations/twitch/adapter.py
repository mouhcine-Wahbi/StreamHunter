"""Twitch adapter (Helix + OAuth). Chat via EventSub and clip creation arrive in Phases 5–6."""

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
from app.integrations.capabilities import api_capability, user_capability
from app.integrations.http import make_client
from app.integrations.twitch.auth import TwitchOAuth
from app.integrations.twitch.client import HelixClient
from app.integrations.twitch.schemas import HelixStream

# Features of this adapter that are actually built. Extended phase by phase.
IMPLEMENTED: frozenset[str] = frozenset({"stream_lookup", "live_detection", "category_lookup"})

CHAT_SCOPES = frozenset({"user:read:chat"})
CLIP_SCOPES = frozenset({"clips:edit"})


class TwitchAdapter(StreamingPlatform):
    platform = Platform.TWITCH

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._client_id = settings.twitch_client_id
        secret = settings.twitch_client_secret.get_secret_value() if settings.twitch_client_secret else ""
        self._has_secret = bool(secret)
        self._http = make_client(transport=transport)
        self._helix: HelixClient | None = None
        self._oauth: TwitchOAuth | None = None
        if self.configured:
            assert self._client_id
            self._helix = HelixClient(self._client_id, secret, self._http)
            self._oauth = TwitchOAuth(self._client_id, secret, settings.twitch_redirect_uri, self._http)

    @property
    def configured(self) -> bool:
        return bool(self._client_id) and self._has_secret

    @property
    def oauth(self) -> OAuthProvider | None:
        return self._oauth

    def capabilities(self, connection: UserConnectionState) -> CapabilityReport:
        cfg = self.configured
        caps = {
            "stream_lookup": api_capability(configured=cfg, implemented="stream_lookup" in IMPLEMENTED),
            "live_detection": api_capability(configured=cfg, implemented="live_detection" in IMPLEMENTED),
            "category_lookup": api_capability(configured=cfg, implemented="category_lookup" in IMPLEMENTED),
            "chat_monitoring": user_capability(
                configured=cfg, implemented="chat_monitoring" in IMPLEMENTED, connection=connection, required_scopes=CHAT_SCOPES
            ),
            "official_clip_creation": user_capability(
                configured=cfg,
                implemented="official_clip_creation" in IMPLEMENTED,
                connection=connection,
                required_scopes=CLIP_SCOPES,
            ),
            # VOD metadata exists via Get Videos; media download is not generally available.
            "vod_analysis": CapabilityState.CONDITIONAL if cfg else CapabilityState.REQUIRES_CONFIGURATION,
            "video_download": CapabilityState.NOT_GUARANTEED,
        }
        notes = []
        if not cfg:
            notes.append("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET on the backend.")
        notes.append("A Twitch clip is a link on Twitch, not a downloadable video file.")
        return CapabilityReport(
            platform=self.platform, configured=cfg, connection_status=connection.status, capabilities=caps, notes=notes
        )

    def _client(self) -> HelixClient:
        if self._helix is None:
            raise PlatformUnavailableError(
                "Twitch is not configured on the backend (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET).",
                code="platform_not_configured",
                details={"platform": "twitch"},
            )
        return self._helix

    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]:
        results = await self._client().search_channels(query, first=limit)
        return [
            ChannelInfo(
                platform=self.platform,
                platform_user_id=r.id,
                username=r.broadcaster_login,
                display_name=r.display_name,
                profile_image_url=r.thumbnail_url or None,
                is_live=r.is_live,
                current_title=r.title or None,
                # Search returns the channel's last category even when offline; only trust it live.
                current_category=(r.game_name or None) if r.is_live else None,
            )
            for r in results
        ]

    async def get_channel(self, username: str) -> ChannelInfo | None:
        helix = self._client()
        users = await helix.get_users(logins=[username.lower()])
        if not users:
            return None
        u = users[0]
        streams = await helix.get_streams([u.id])
        live = _live_stream(streams, u.id)
        return ChannelInfo(
            platform=self.platform,
            platform_user_id=u.id,
            username=u.login,
            display_name=u.display_name,
            profile_image_url=u.profile_image_url or None,
            is_live=live is not None,
            current_title=live.title if live else None,
            current_category=(live.game_name or None) if live else None,
        )

    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]:
        ids = list(dict.fromkeys(platform_user_ids))
        if not ids:
            return {}
        streams = await self._client().get_streams(ids)
        live = {s.user_id: s for s in streams if s.type == "live"}
        # Get Streams only returns live channels; absence means offline.
        return {
            uid: LiveStatus(
                platform_user_id=uid,
                is_live=uid in live,
                title=live[uid].title if uid in live else None,
                category=(live[uid].game_name or None) if uid in live else None,
                viewer_count=live[uid].viewer_count if uid in live else None,
                started_at=live[uid].started_at if uid in live else None,
            )
            for uid in ids
        }

    async def aclose(self) -> None:
        await self._http.aclose()


def _live_stream(streams: list[HelixStream], user_id: str) -> HelixStream | None:
    return next((s for s in streams if s.user_id == user_id and s.type == "live"), None)
