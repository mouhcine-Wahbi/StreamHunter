"""Kick adapter (Kick public API v1/v2 + signed webhooks).

Verified constraints (KickEngineering/KickDevDocs, see ARCHITECTURE.md §3):
  * chat is only delivered via webhooks to a public HTTPS URL;
  * there is no official clip-creation API and no VOD/media API.

Phase 2 provides configuration detection and capability reporting. The API calls are
implemented in Phase 3; until then they return an explicit `not_implemented` error.
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
from app.integrations.capabilities import api_capability

IMPLEMENTED: frozenset[str] = frozenset()


class KickAdapter(StreamingPlatform):
    platform = Platform.KICK

    def __init__(self, settings: Settings):
        self._client_id = settings.kick_client_id
        self._has_secret = settings.kick_client_secret is not None and bool(
            settings.kick_client_secret.get_secret_value()
        )
        self._webhook_url = settings.kick_webhook_public_url

    @property
    def configured(self) -> bool:
        return bool(self._client_id) and self._has_secret

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
        if not self._webhook_url:
            notes.append("Kick chat needs a public HTTPS webhook URL (KICK_WEBHOOK_PUBLIC_URL), e.g. a tunnel.")
        notes.append("Kick has no official clip API: clips are created manually on Kick.")
        return CapabilityReport(
            platform=self.platform, configured=cfg, connection_status=connection.status, capabilities=caps, notes=notes
        )

    def _require_ready(self) -> None:
        if not self.configured:
            raise PlatformUnavailableError(
                "Kick is not configured on the backend (KICK_CLIENT_ID / KICK_CLIENT_SECRET).",
                code="platform_not_configured",
                details={"platform": "kick"},
            )
        raise PlatformNotImplementedError(
            "Kick API calls are not available in this backend version yet (planned for Phase 3).",
            details={"platform": "kick"},
        )

    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]:
        self._require_ready()
        return []

    async def get_channel(self, username: str) -> ChannelInfo | None:
        self._require_ready()
        return None

    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]:
        self._require_ready()
        return {}
