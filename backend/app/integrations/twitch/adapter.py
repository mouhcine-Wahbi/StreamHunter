"""Twitch adapter (Helix + EventSub).

Phase 2 provides configuration detection and capability reporting. The Helix calls
(search, lookup, live status) are implemented in Phase 3; until then they return an
explicit `not_implemented` error instead of fake results.
"""

from __future__ import annotations

from app.config import Settings
from app.domain.enums import Platform
from app.errors import PlatformNotImplementedError, PlatformUnavailableError
from app.integrations.base import (
    CapabilityReport,
    CapabilityState,
    ChannelInfo,
    LiveStatus,
    StreamingPlatform,
    UserConnectionState,
)
from app.integrations.capabilities import api_capability, user_capability

# Features of this adapter that are actually built. Extended phase by phase.
IMPLEMENTED: frozenset[str] = frozenset()

CHAT_SCOPES = frozenset({"user:read:chat"})
CLIP_SCOPES = frozenset({"clips:edit"})


class TwitchAdapter(StreamingPlatform):
    platform = Platform.TWITCH

    def __init__(self, settings: Settings):
        self._client_id = settings.twitch_client_id
        self._has_secret = settings.twitch_client_secret is not None and bool(
            settings.twitch_client_secret.get_secret_value()
        )

    @property
    def configured(self) -> bool:
        return bool(self._client_id) and self._has_secret

    def capabilities(self, connection: UserConnectionState) -> CapabilityReport:
        cfg = self.configured
        caps = {
            "stream_lookup": api_capability(configured=cfg, implemented="stream_lookup" in IMPLEMENTED),
            "live_detection": api_capability(configured=cfg, implemented="live_detection" in IMPLEMENTED),
            "category_lookup": api_capability(configured=cfg, implemented="category_lookup" in IMPLEMENTED),
            "chat_monitoring": user_capability(
                configured=cfg,
                implemented="chat_monitoring" in IMPLEMENTED,
                connection=connection,
                required_scopes=CHAT_SCOPES,
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

    def _require_ready(self) -> None:
        if not self.configured:
            raise PlatformUnavailableError(
                "Twitch is not configured on the backend (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET).",
                code="platform_not_configured",
                details={"platform": "twitch"},
            )
        raise PlatformNotImplementedError(
            "Twitch API calls are not available in this backend version yet (planned for Phase 3).",
            details={"platform": "twitch"},
        )

    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]:
        self._require_ready()
        return []  # unreachable; keeps the type checker satisfied

    async def get_channel(self, username: str) -> ChannelInfo | None:
        self._require_ready()
        return None

    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]:
        self._require_ready()
        return {}
