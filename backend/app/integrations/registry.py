from __future__ import annotations

from collections.abc import Mapping

from app.config import Settings
from app.domain.enums import Platform
from app.integrations.base import StreamingPlatform
from app.integrations.kick.adapter import KickAdapter
from app.integrations.twitch.adapter import TwitchAdapter


class PlatformRegistry:
    """Holds one adapter per platform. Tests swap adapters via dependency overrides."""

    def __init__(self, adapters: Mapping[Platform, StreamingPlatform]):
        self._adapters = dict(adapters)

    @classmethod
    def from_settings(cls, settings: Settings) -> PlatformRegistry:
        return cls({Platform.TWITCH: TwitchAdapter(settings), Platform.KICK: KickAdapter(settings)})

    def get(self, platform: Platform) -> StreamingPlatform:
        return self._adapters[platform]

    def all(self) -> list[StreamingPlatform]:
        return list(self._adapters.values())

    async def aclose(self) -> None:
        for adapter in self._adapters.values():
            await adapter.aclose()
