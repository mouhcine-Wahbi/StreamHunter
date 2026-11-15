"""Twitch/Kick adapters against mocked platform APIs (no network)."""

from __future__ import annotations

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings
from app.db.base import Base
from app.domain.enums import Platform
from app.errors import PlatformUnavailableError, UpstreamError
from app.integrations.base import CapabilityState as C
from app.integrations.base import UserConnectionState
from app.integrations.http import PlatformRateLimited, RequestSpec, send
from app.integrations.kick.adapter import KickAdapter
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.main import create_app
from tests.platform_mocks import FakeKick, FakeTwitch, transport


def make_settings(**kw: object) -> Settings:
    return Settings(_env_file=None, app_env="test", **kw)  # type: ignore[arg-type]


TW = dict(twitch_client_id="tw-client", twitch_client_secret=SecretStr("tw-secret"))
KK = dict(kick_client_id="kick-client", kick_client_secret=SecretStr("kick-secret"))


@pytest.fixture
def tw() -> FakeTwitch:
    return FakeTwitch()


@pytest.fixture
def kk() -> FakeKick:
    return FakeKick()


@pytest.fixture
def twitch(tw: FakeTwitch) -> TwitchAdapter:
    return TwitchAdapter(make_settings(**TW), transport=transport(tw.handler))


@pytest.fixture
def kick(kk: FakeKick) -> KickAdapter:
    return KickAdapter(make_settings(**KK), transport=transport(kk.handler))


# --- capability reporting ---------------------------------------------------------------
def test_unconfigured_adapters_require_configuration() -> None:
    s = make_settings()
    tw = TwitchAdapter(s).capabilities(UserConnectionState())
    kk = KickAdapter(s).capabilities(UserConnectionState())
    assert not tw.configured and not kk.configured
    assert tw.capabilities["stream_lookup"] == C.REQUIRES_CONFIGURATION
    assert tw.capabilities["video_download"] == C.NOT_GUARANTEED
    assert kk.capabilities["chat_monitoring"] == C.REQUIRES_CONFIGURATION
    assert kk.capabilities["official_clip_creation"] == C.REQUIRES_MANUAL_ACTION
    assert kk.capabilities["vod_analysis"] == C.UNSUPPORTED


def test_configured_capabilities() -> None:
    caps = TwitchAdapter(make_settings(**TW)).capabilities(UserConnectionState()).capabilities
    assert caps["stream_lookup"] == caps["live_detection"] == caps["category_lookup"] == C.SUPPORTED
    assert caps["chat_monitoring"] == C.NOT_IMPLEMENTED  # Phase 5
    kcaps = KickAdapter(make_settings(**KK)).capabilities(UserConnectionState()).capabilities
    assert kcaps["stream_lookup"] == C.SUPPORTED
    assert kcaps["chat_monitoring"] == C.REQUIRES_CONFIGURATION  # no webhook URL


def test_blank_env_values_count_as_missing() -> None:
    assert not TwitchAdapter(make_settings(twitch_client_id="  ", twitch_client_secret=SecretStr(""))).configured


async def test_unconfigured_calls_raise_explicit_errors() -> None:
    with pytest.raises(PlatformUnavailableError) as e:
        await TwitchAdapter(make_settings()).search_channels("x")
    assert e.value.code == "platform_not_configured"
    with pytest.raises(PlatformUnavailableError):
        await KickAdapter(make_settings()).get_channel("x")


# --- Twitch -----------------------------------------------------------------------------
async def test_twitch_search(twitch: TwitchAdapter, tw: FakeTwitch) -> None:
    results = await twitch.search_channels("one", limit=5)
    by = {r.username: r for r in results}
    live, off = by["streamerone"], by["quietone"]
    assert live.is_live and live.current_category == "Valorant" and live.platform_user_id == "101"
    assert live.profile_image_url == "https://static-cdn.example/101.png"
    # Offline channels: Twitch returns the last category, but it is not "current".
    assert off.is_live is False and off.current_category is None and off.profile_image_url is None
    req = tw.requests[-1]
    assert req.headers["Client-Id"] == "tw-client" and req.url.params["first"] == "5"


async def test_twitch_get_channel(twitch: TwitchAdapter) -> None:
    ch = await twitch.get_channel("StreamerOne")
    assert ch and ch.platform_user_id == "101" and ch.display_name == "StreamerOne" and ch.is_live
    assert ch.current_title == "Ranked grind"
    quiet = await twitch.get_channel("quietone")
    assert quiet and quiet.is_live is False and quiet.current_title is None
    assert await twitch.get_channel("nobody") is None


async def test_twitch_live_status_batches_and_reports_offline(twitch: TwitchAdapter, tw: FakeTwitch) -> None:
    ids = ["101", "102"] + [str(1000 + i) for i in range(150)]
    statuses = await twitch.get_live_status(ids)
    assert statuses["101"].is_live and statuses["101"].viewer_count == 4321
    assert statuses["101"].started_at and statuses["101"].started_at.tzinfo is not None
    assert statuses["102"].is_live is False and statuses["102"].title is None
    assert len(statuses) == 152
    stream_calls = [r for r in tw.requests if r.url.path == "/helix/streams"]
    assert len(stream_calls) == 2  # 152 ids → 100 + 52


async def test_twitch_app_token_is_cached_and_renewed_after_401(twitch: TwitchAdapter, tw: FakeTwitch) -> None:
    await twitch.get_channel("streamerone")
    await twitch.get_channel("streamerone")
    assert tw.app_tokens_issued == 1
    tw.reject_next_app_token_use = True
    assert await twitch.get_channel("streamerone")
    assert tw.app_tokens_issued == 2


async def test_twitch_bad_secret_is_reported() -> None:
    tw = FakeTwitch()
    a = TwitchAdapter(make_settings(twitch_client_id="tw-client", twitch_client_secret=SecretStr("wrong")), transport=transport(tw.handler))
    with pytest.raises(Exception) as e:
        await a.search_channels("x")
    assert getattr(e.value, "code", "") == "platform_auth_failed"


# --- Kick -------------------------------------------------------------------------------
async def test_kick_lookup_is_exact_slug(kick: KickAdapter, kk: FakeKick) -> None:
    res = await kick.search_channels("KickStar")
    assert len(res) == 1
    c = res[0]
    assert c.platform_user_id == "501" and c.display_name == "KickStar" and c.is_live
    assert c.current_category == "IRL" and c.profile_image_url == "https://files.kick.example/501.webp"
    assert await kick.search_channels("kick") == []  # no fuzzy search on Kick
    assert kk.requests[0].url.host == "id.kick.com"  # app token first


async def test_kick_offline_and_zero_time(kick: KickAdapter) -> None:
    c = await kick.get_channel("sleepy")
    assert c and c.is_live is False and c.current_title is None and c.profile_image_url is None
    st = await kick.get_live_status(["501", "502", "999"])
    assert st["501"].is_live and st["501"].viewer_count == 2100
    assert st["502"].is_live is False and st["502"].started_at is None
    assert "999" not in st  # unknown is omitted, never guessed


async def test_kick_unexpected_shape_is_an_explicit_error(kick: KickAdapter, kk: FakeKick) -> None:
    kk.malformed = True
    with pytest.raises(UpstreamError):
        await kick.get_channel("kickstar")


# --- HTTP plumbing ----------------------------------------------------------------------
async def test_retry_on_5xx_then_success_and_rate_limit() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] == 1 else httpx.Response(200, json={})

    async def no_sleep(_: float) -> None:
        return None

    async with httpx.AsyncClient(transport=transport(handler)) as c:
        r = await send(c, RequestSpec("twitch", "GET", "https://api.twitch.tv/x"), sleep=no_sleep)
        assert r.status_code == 200 and calls["n"] == 2

    async with httpx.AsyncClient(transport=transport(lambda r: httpx.Response(429, headers={"Retry-After": "60"}))) as c:
        with pytest.raises(PlatformRateLimited):
            await send(c, RequestSpec("kick", "GET", "https://api.kick.com/x"), sleep=no_sleep)


# --- API end to end with the real (unconfigured) adapters -------------------------------
async def test_api_reports_real_adapter_state(tmp_path) -> None:
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
        r = await c.get("/api/v1/streamers/search", params={"platform": Platform.KICK.value, "username": "xqc"}, headers=h)
        assert r.status_code == 503 and r.json()["error"]["code"] == "platform_not_configured"
    await app.state.engine.dispose()
