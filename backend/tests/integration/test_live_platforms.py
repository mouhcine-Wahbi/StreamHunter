"""Live checks against the real Twitch / Kick APIs.

Deselected by default. Run with real credentials in the environment:

    TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... KICK_CLIENT_ID=... KICK_CLIENT_SECRET=... \
    .venv/bin/python -m pytest -m integration -v

Optional: SH_TWITCH_LOGIN / SH_KICK_SLUG choose which channel to look up.
These tests confirm the response field names that could not be verified offline
(see app/integrations/kick/schemas.py).
"""

from __future__ import annotations

import os

import pytest

from app.config import Settings
from app.integrations.kick.adapter import KickAdapter
from app.integrations.twitch.adapter import TwitchAdapter

pytestmark = pytest.mark.integration


def _settings() -> Settings:
    return Settings(app_env="test")


@pytest.mark.skipif(not os.getenv("TWITCH_CLIENT_ID"), reason="TWITCH_CLIENT_ID not set")
async def test_twitch_live_lookup() -> None:
    adapter = TwitchAdapter(_settings())
    try:
        login = os.getenv("SH_TWITCH_LOGIN", "twitch")
        ch = await adapter.get_channel(login)
        assert ch is not None and ch.platform_user_id.isdigit()
        assert await adapter.search_channels(login, limit=3)
        st = await adapter.get_live_status([ch.platform_user_id])
        assert ch.platform_user_id in st
    finally:
        await adapter.aclose()


@pytest.mark.skipif(not os.getenv("KICK_CLIENT_ID"), reason="KICK_CLIENT_ID not set")
async def test_kick_live_lookup() -> None:
    adapter = KickAdapter(_settings())
    try:
        slug = os.getenv("SH_KICK_SLUG", "kick")
        ch = await adapter.get_channel(slug)
        assert ch is not None, f"Kick channel '{slug}' not found or response shape changed"
        assert ch.platform_user_id and ch.username == slug
        st = await adapter.get_live_status([ch.platform_user_id])
        assert ch.platform_user_id in st, "Kick channels response lacks stream.is_live (schema drift?)"
    finally:
        await adapter.aclose()
