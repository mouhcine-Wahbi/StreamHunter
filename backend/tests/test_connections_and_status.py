"""Platform account connections (OAuth) and live-status refresh through the API.

Uses the real Twitch/Kick adapters on top of mocked platform HTTP APIs.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import select, update

from app.config import Settings
from app.db.base import Base
from app.domain.enums import Platform
from app.integrations.kick.adapter import KickAdapter
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.main import create_app
from app.models import OAuthState, PlatformConnection, User
from app.services.connection_service import ConnectionService
from tests.platform_mocks import FakeKick, FakeTwitch, transport


@pytest.fixture
def tw() -> FakeTwitch:
    return FakeTwitch()


@pytest.fixture
def kk() -> FakeKick:
    return FakeKick()


@pytest.fixture
async def ctx(tmp_path, tw: FakeTwitch, kk: FakeKick) -> AsyncIterator[tuple]:
    settings = Settings(
        _env_file=None,
        app_env="test",
        scheduler_enabled=False,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'c.db'}",
        token_encryption_key=SecretStr(Fernet.generate_key().decode()),
        twitch_client_id="tw-client",
        twitch_client_secret=SecretStr("tw-secret"),
        kick_client_id="kick-client",
        kick_client_secret=SecretStr("kick-secret"),
    )
    registry = PlatformRegistry(
        {
            Platform.TWITCH: TwitchAdapter(settings, transport=transport(tw.handler)),
            Platform.KICK: KickAdapter(settings, transport=transport(kk.handler)),
        }
    )
    app = create_app(settings, registry=registry)
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v1/auth/register", json={"email": "ed@example.com", "username": "ed", "password": "long password"})
        headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
        yield app, client, headers
    await app.state.engine.dispose()


def _q(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


async def test_twitch_connect_flow_end_to_end(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    r = await client.get("/api/v1/auth/twitch/authorize", headers=h)
    assert r.status_code == 200
    url = r.json()["authorization_url"]
    q = _q(url)
    assert url.startswith("https://id.twitch.tv/oauth2/authorize?")
    assert q["client_id"] == "tw-client" and q["response_type"] == "code"
    assert q["scope"] == "user:read:chat clips:edit"
    assert "client_secret" not in url and "code_challenge" not in q

    cb = await client.get("/api/v1/auth/twitch/callback", params={"code": "good-code", "state": q["state"]})
    assert cb.status_code == 200 and "editorlogin" in cb.text
    assert "default-src 'none'" in cb.headers["content-security-policy"]

    st = (await client.get("/api/v1/auth/twitch/status", headers=h)).json()
    assert st["connection_status"] == "connected" and st["platform_username"] == "editorlogin"
    assert st["scopes"] == ["clips:edit", "user:read:chat"]

    # Tokens are encrypted at rest.
    async with app.state.sessionmaker() as db:
        conn = await db.scalar(select(PlatformConnection))
        assert conn.access_token_enc and "user-at" not in conn.access_token_enc
        assert app.state.token_cipher.decrypt(conn.access_token_enc) == "user-at"

    caps = {c["platform"]: c for c in (await client.get("/api/v1/platforms/capabilities", headers=h)).json()}
    assert caps["twitch"]["connection_status"] == "connected"

    # Replaying the callback fails: state is single use.
    again = await client.get("/api/v1/auth/twitch/callback", params={"code": "good-code", "state": q["state"]})
    assert again.status_code == 400 and "already used" in again.text

    assert (await client.post("/api/v1/auth/twitch/disconnect", headers=h)).status_code == 204
    assert set(tw.revoked) == {"user-at", "user-rt"}
    st = (await client.get("/api/v1/auth/twitch/status", headers=h)).json()
    assert st["connection_status"] == "not_connected" and st["scopes"] == []


async def test_kick_connect_uses_pkce(ctx, kk: FakeKick) -> None:
    import base64
    import hashlib

    _, client, h = ctx
    url = (await client.get("/api/v1/auth/kick/authorize", headers=h)).json()["authorization_url"]
    q = _q(url)
    assert url.startswith("https://id.kick.com/oauth/authorize?")
    assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) == 43
    assert q["scope"] == "user:read channel:read events:subscribe"

    cb = await client.get("/api/v1/auth/kick/callback", params={"code": "kick-code", "state": q["state"]})
    assert cb.status_code == 200, cb.text
    verifier = kk.last_token_form["code_verifier"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert expected == q["code_challenge"]  # the verifier sent matches the challenge
    st = (await client.get("/api/v1/auth/kick/status", headers=h)).json()
    assert st["connection_status"] == "connected" and st["platform_user_id"] == "777"


async def test_callback_rejections(ctx) -> None:
    app, client, h = ctx
    bad = await client.get("/api/v1/auth/twitch/callback", params={"code": "x", "state": "forged"})
    assert bad.status_code == 400 and "not valid" in bad.text

    # A state issued for Twitch cannot complete a Kick connection.
    state = _q((await client.get("/api/v1/auth/twitch/authorize", headers=h)).json()["authorization_url"])["state"]
    assert (await client.get("/api/v1/auth/kick/callback", params={"code": "x", "state": state})).status_code == 400

    # Expired.
    async with app.state.sessionmaker() as db:
        await db.execute(update(OAuthState).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await db.commit()
    assert "expired" in (await client.get("/api/v1/auth/twitch/callback", params={"code": "good-code", "state": state})).text

    # User denied on the platform.
    state = _q((await client.get("/api/v1/auth/twitch/authorize", headers=h)).json()["authorization_url"])["state"]
    denied = await client.get("/api/v1/auth/twitch/callback", params={"error": "access_denied", "state": state})
    assert denied.status_code == 400 and "denied" in denied.text
    assert (await client.get("/api/v1/auth/twitch/status", headers=h)).json()["connection_status"] == "not_connected"

    # Invalid code from the platform → error recorded, nothing stored.
    state = _q((await client.get("/api/v1/auth/twitch/authorize", headers=h)).json()["authorization_url"])["state"]
    r = await client.get("/api/v1/auth/twitch/callback", params={"code": "bad-code", "state": state})
    assert r.status_code == 400
    st = (await client.get("/api/v1/auth/twitch/status", headers=h)).json()
    assert st["connection_status"] == "error" and st["last_error"]


async def test_callback_escapes_reflected_values(ctx) -> None:
    _, client, _ = ctx
    r = await client.get("/api/v1/auth/twitch/callback", params={"code": "<script>alert(1)</script>", "state": "<b>x</b>"})
    assert "<script>" not in r.text and "<b>x</b>" not in r.text


async def test_authorize_requires_encryption_key(ctx) -> None:
    from app.utils.crypto import TokenCipher

    app, client, h = ctx
    app.state.token_cipher = TokenCipher(None)
    r = await client.get("/api/v1/auth/twitch/authorize", headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "encryption_not_configured"


async def test_access_token_refresh(ctx) -> None:
    app, client, h = ctx
    state = _q((await client.get("/api/v1/auth/twitch/authorize", headers=h)).json()["authorization_url"])["state"]
    await client.get("/api/v1/auth/twitch/callback", params={"code": "good-code", "state": state})
    async with app.state.sessionmaker() as db:
        user = await db.scalar(select(User))
        svc = ConnectionService(db, app.state.registry, app.state.token_cipher)
        assert await svc.access_token(user, Platform.TWITCH) == "user-at"
        await db.execute(update(PlatformConnection).values(token_expires_at=datetime.now(UTC) + timedelta(minutes=1)))
        assert await svc.access_token(user, Platform.TWITCH) == "user-at-2"  # refreshed
        await db.commit()


# --- watchlist + live status ------------------------------------------------------------
async def test_add_real_streamers_and_refresh_status(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    a = await client.post("/api/v1/streamers", json={"platform": "twitch", "username": "StreamerOne"}, headers=h)
    b = await client.post("/api/v1/streamers", json={"platform": "kick", "username": "sleepy"}, headers=h)
    assert a.status_code == b.status_code == 201
    assert a.json()["is_live"] is True and a.json()["current_category"] == "Valorant"
    assert b.json()["is_live"] is False

    # Fresh check of one streamer.
    st = (await client.get(f"/api/v1/streams/{a.json()['id']}/status", headers=h)).json()
    assert st["is_live"] and st["viewer_count"] == 4321 and st["last_checked_at"] is not None

    # StreamerOne goes offline; batched refresh picks it up (Kick one was not checked recently → checked).
    tw.live.clear()
    async with app.state.sessionmaker() as db:  # pretend the last check was a while ago
        from app.models import Streamer

        await db.execute(update(Streamer).values(status_checked_at=datetime.now(UTC) - timedelta(minutes=5)))
        await db.commit()
    summary = (await client.post("/api/v1/streams/refresh", headers=h)).json()
    assert summary == {"checked": 2, "live": 0, "skipped_recent": 0, "unavailable": {}}
    st = (await client.get(f"/api/v1/streams/{a.json()['id']}", headers=h)).json()
    assert st["is_live"] is False and st["category"] is None and st["viewer_count"] is None

    # Immediately again: both were just checked → skipped (rate-limit friendly).
    again = (await client.post("/api/v1/streams/refresh", headers=h)).json()
    assert again["checked"] == 0 and again["skipped_recent"] == 2
