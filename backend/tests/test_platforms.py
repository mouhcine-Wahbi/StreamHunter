"""Real Twitch/Kick adapters: configuration detection and honest capability reporting."""

from __future__ import annotations

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings
from app.domain.enums import ConnectionStatus, Platform
from app.errors import PlatformNotImplementedError, PlatformUnavailableError
from app.integrations.base import CapabilityState as C
from app.integrations.base import UserConnectionState
from app.integrations.kick.adapter import KickAdapter
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.main import create_app
from app.db.base import Base


def make_settings(**kw: object) -> Settings:
    return Settings(_env_file=None, app_env="test", **kw)  # type: ignore[arg-type]


def test_unconfigured_adapters_require_configuration() -> None:
    s = make_settings()
    tw = TwitchAdapter(s).capabilities(UserConnectionState())
    kk = KickAdapter(s).capabilities(UserConnectionState())
    assert not tw.configured and not kk.configured
    assert tw.capabilities["stream_lookup"] == C.REQUIRES_CONFIGURATION
    assert tw.capabilities["video_download"] == C.NOT_GUARANTEED
    assert kk.capabilities["chat_monitoring"] == C.REQUIRES_CONFIGURATION
    # Facts that do not depend on configuration:
    assert kk.capabilities["official_clip_creation"] == C.REQUIRES_MANUAL_ACTION
    assert kk.capabilities["vod_analysis"] == C.UNSUPPORTED
    assert any("TWITCH_CLIENT_ID" in n for n in tw.notes)


def test_configured_but_unbuilt_features_say_not_implemented() -> None:
    s = make_settings(twitch_client_id="id", twitch_client_secret=SecretStr("secret"))
    caps = TwitchAdapter(s).capabilities(UserConnectionState()).capabilities
    assert caps["stream_lookup"] == C.NOT_IMPLEMENTED
    assert caps["chat_monitoring"] == C.NOT_IMPLEMENTED
    assert caps["vod_analysis"] == C.CONDITIONAL


def test_kick_chat_needs_public_webhook_url() -> None:
    no_url = make_settings(kick_client_id="id", kick_client_secret=SecretStr("s"))
    with_url = make_settings(kick_client_id="id", kick_client_secret=SecretStr("s"), kick_webhook_public_url="https://x.example")
    assert KickAdapter(no_url).capabilities(UserConnectionState()).capabilities["chat_monitoring"] == C.REQUIRES_CONFIGURATION
    assert KickAdapter(with_url).capabilities(UserConnectionState()).capabilities["chat_monitoring"] == C.NOT_IMPLEMENTED


def test_blank_env_values_count_as_missing() -> None:
    assert not TwitchAdapter(make_settings(twitch_client_id="  ", twitch_client_secret=SecretStr(""))).configured


async def test_unconfigured_calls_raise_explicit_errors() -> None:
    with pytest.raises(PlatformUnavailableError) as e:
        await TwitchAdapter(make_settings()).search_channels("x")
    assert e.value.code == "platform_not_configured"
    with pytest.raises(PlatformNotImplementedError):
        await KickAdapter(make_settings(kick_client_id="id", kick_client_secret=SecretStr("s"))).get_channel("x")


async def test_api_reports_real_adapter_state(tmp_path) -> None:
    """End to end with the real (unconfigured) adapters: no fake search results, clear errors."""
    settings = make_settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'p.db'}")
    app = create_app(settings, registry=PlatformRegistry.from_settings(settings))
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        tok = (
            await c.post("/api/v1/auth/register", json={"email": "a@example.com", "username": "aa", "password": "long password"})
        ).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        caps = (await c.get("/api/v1/platforms/capabilities", headers=h)).json()
        assert {x["platform"] for x in caps} == {"twitch", "kick"}
        assert all(x["connection_status"] == ConnectionStatus.NOT_CONNECTED for x in caps)

        r = await c.get("/api/v1/streamers/search", params={"platform": Platform.KICK.value, "username": "xqc"}, headers=h)
        assert r.status_code == 503
        assert r.json()["error"]["code"] == "platform_not_configured"
        r = await c.post("/api/v1/streamers", json={"platform": "twitch", "username": "shroud"}, headers=h)
        assert r.status_code == 503
    await app.state.engine.dispose()
