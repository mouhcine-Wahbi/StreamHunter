"""Test doubles for platform adapters. Used only by the automated test suite."""

from __future__ import annotations

from datetime import UTC, datetime

from app.domain.enums import Platform
from app.integrations.base import (
    CAPABILITY_KEYS,
    CapabilityReport,
    CapabilityState,
    ChannelInfo,
    LiveStatus,
    StreamingPlatform,
    UserConnectionState,
)


class FakePlatform(StreamingPlatform):
    def __init__(self, platform: Platform, channels: list[ChannelInfo] | None = None):
        self.platform = platform
        self.channels = {c.username.lower(): c for c in channels or []}
        self.calls: list[tuple[str, object]] = []
        # Set by tests: platform_user_id -> LiveStatus. Ids not present are not reported.
        self.live: dict[str, LiveStatus] = {}
        self.fail_with: Exception | None = None

    @property
    def configured(self) -> bool:
        return True

    def capabilities(self, connection: UserConnectionState) -> CapabilityReport:
        return CapabilityReport(
            platform=self.platform,
            configured=True,
            connection_status=connection.status,
            capabilities={k: CapabilityState.SUPPORTED for k in CAPABILITY_KEYS},
        )

    async def search_channels(self, query: str, limit: int = 10) -> list[ChannelInfo]:
        self.calls.append(("search", query))
        q = query.lower()
        return [c for name, c in self.channels.items() if q in name][:limit]

    async def get_channel(self, username: str) -> ChannelInfo | None:
        self.calls.append(("get_channel", username))
        return self.channels.get(username.lower())

    async def get_live_status(self, platform_user_ids: list[str]) -> dict[str, LiveStatus]:
        self.calls.append(("live_status", tuple(platform_user_ids)))
        if self.fail_with:
            raise self.fail_with
        return {k: v for k, v in self.live.items() if k in platform_user_ids}

    def set_live(self, uid: str, live: bool, *, started: datetime | None = None, title: str = "Live now") -> None:
        self.live[uid] = LiveStatus(
            platform_user_id=uid,
            is_live=live,
            title=title if live else None,
            category="Just Chatting" if live else None,
            viewer_count=100 if live else None,
            started_at=(started or datetime(2026, 11, 15, 5, 0, tzinfo=UTC)) if live else None,
        )


def channel(platform: Platform, uid: str, username: str, *, live: bool | None = False) -> ChannelInfo:
    return ChannelInfo(
        platform=platform,
        platform_user_id=uid,
        username=username,
        display_name=username.capitalize(),
        profile_image_url=f"https://example.test/{username}.png",
        is_live=live,
        current_title="Test stream" if live else None,
        current_category="Just Chatting" if live else None,
    )
