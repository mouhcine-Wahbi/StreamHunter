"""Editor review and clip workflow, with the real Twitch adapter on a mocked Helix API."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import select

from app.config import Settings
from app.db.base import Base
from app.detection.models import CandidateDraft, Strictness
from app.domain.enums import Platform
from app.integrations.kick.adapter import KickAdapter
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.main import create_app
from app.models import Clip, HighlightCandidate, MonitoringSession, Streamer, User
from tests.platform_mocks import FakeKick, FakeTwitch, transport


async def _no_sleep(_: float) -> None:
    return None


@pytest.fixture
def tw() -> FakeTwitch:
    return FakeTwitch()


@pytest.fixture
async def ctx(tmp_path, tw: FakeTwitch) -> AsyncIterator[tuple]:  # type: ignore[type-arg]
    kk = FakeKick()
    settings = Settings(
        _env_file=None, app_env="test", scheduler_enabled=False,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'clips.db'}",
        token_encryption_key=SecretStr(Fernet.generate_key().decode()),
        twitch_client_id="tw-client", twitch_client_secret=SecretStr("tw-secret"),
        kick_client_id="kick-client", kick_client_secret=SecretStr("kick-secret"),
    )
    registry = PlatformRegistry({
        Platform.TWITCH: TwitchAdapter(settings, transport=transport(tw.handler)),
        Platform.KICK: KickAdapter(settings, transport=transport(kk.handler)),
    })
    app = create_app(settings, registry=registry)
    app.state.clip_worker._sleep = _no_sleep
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v1/auth/register", json={"email": "ed@example.com", "username": "ed", "password": "long password"})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        yield app, client, h
    await app.state.clip_worker.stop()
    await app.state.engine.dispose()


async def _connect_twitch(client, h) -> None:  # type: ignore[no-untyped-def]
    url = (await client.get("/api/v1/auth/twitch/authorize", headers=h)).json()["authorization_url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    assert (await client.get("/api/v1/auth/twitch/callback", params={"code": "good-code", "state": state})).status_code == 200


async def _candidate(app, client, h, *, platform="twitch", username="streamerone", age_s: int = 20) -> int:  # type: ignore[no-untyped-def]
    if platform == "twitch":
        assert (await client.post("/api/v1/streamers", json={"platform": "twitch", "username": username}, headers=h)).status_code == 201
    async with app.state.sessionmaker() as db:
        user = await db.scalar(select(User))
        streamer = await db.scalar(select(Streamer).where(Streamer.username == username))
        if streamer is None:  # Kick streamer without going through the Kick API
            streamer = Streamer(platform="kick", platform_user_id="501", username=username, display_name="KickStar", is_live=True)
            db.add(streamer)
            await db.flush()
        now = datetime.now(UTC)
        sess = MonitoringSession(user_id=user.id, streamer_id=streamer.id, platform=platform, status="active",
                                 started_at=now - timedelta(hours=1), broadcast_started_at=now - timedelta(hours=1))
        db.add(sess)
        await db.flush()
        c = HighlightCandidate(user_id=user.id, session_id=sess.id, streamer_id=streamer.id, platform=platform,
                               timestamp=now - timedelta(seconds=age_s), start_offset_sec=3570, end_offset_sec=3610,
                               score=82, confidence=0.9, category="funny_moment", reasons=["'KEKW' used by 40 chatters"],
                               status="pending_review")
        db.add(c)
        await db.commit()
        return c.id


async def test_twitch_approve_create_confirm(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    await _connect_twitch(client, h)
    cid = await _candidate(app, client, h)
    r = await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["highlight"]["status"] == "approved"
    clip = body["clip"]
    assert clip["status"] == "approved" and clip["platform"] == "twitch" and clip["aspect_ratio"] == "9:16"
    assert clip["duration_seconds"] == 40 and clip["platform_clip_url"] is None  # nothing exists yet

    tw.clip_ready_after = 2  # Twitch needs two polls before the clip shows up
    created = await client.post(f"/api/v1/clips/{clip['id']}/create", json={}, headers=h)
    assert created.status_code == 200, created.text
    c = created.json()
    assert c["status"] == "created" and c["platform_clip_url"] == "https://clips.twitch.tv/Clip1"
    assert c["edit_url"] == "https://clips.twitch.tv/Clip1/edit" and c["source"] == "editor"
    assert c["local_file_path"] is None, "a Twitch clip is a link, not a file"
    assert 15 <= c["request_lag_seconds"] < 60
    assert tw.clips_requested == [{"id": "Clip1", "broadcaster_id": "101", "has_delay": "false"}]

    listed = (await client.get("/api/v1/highlights", headers=h)).json()["items"][0]
    assert listed["clip"]["status"] == "created" and listed["streamer_username"] == "streamerone"

    # Double create is refused.
    assert (await client.post(f"/api/v1/clips/{clip['id']}/create", json={}, headers=h)).json()["error"]["code"] == "invalid_status_transition"


async def test_unconfirmed_clip_fails_then_retry_succeeds(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    await _connect_twitch(client, h)
    cid = await _candidate(app, client, h)
    clip_id = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]["id"]
    tw.clip_ready_after = 99  # never appears
    c = (await client.post(f"/api/v1/clips/{clip_id}/create", json={}, headers=h)).json()
    assert c["status"] == "failed" and "did not confirm" in c["error_message"]
    assert c["platform_clip_url"] is None
    tw.clip_ready_after = 1
    c = (await client.post(f"/api/v1/clips/{clip_id}/retry", json={}, headers=h)).json()
    assert c["status"] == "created" and c["platform_clip_url"].startswith("https://clips.twitch.tv/")


async def test_moment_passed_needs_explicit_choice(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    await _connect_twitch(client, h)
    cid = await _candidate(app, client, h, age_s=600)
    clip_id = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]["id"]
    r = await client.post(f"/api/v1/clips/{clip_id}/create", json={}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "moment_passed"
    assert "current broadcast" in r.json()["error"]["message"]
    assert tw.clips_requested == []
    c = (await client.post(f"/api/v1/clips/{clip_id}/create", json={"accept_current_moment": True}, headers=h)).json()
    assert c["status"] == "created" and c["request_lag_seconds"] >= 600


async def test_preconditions_and_platform_refusals(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    cid = await _candidate(app, client, h)
    clip_id = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]["id"]
    r = await client.post(f"/api/v1/clips/{clip_id}/create", json={}, headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "requires_authorization"

    await _connect_twitch(client, h)
    tw.live.clear()  # Twitch says offline although our last status said live
    c = (await client.post(f"/api/v1/clips/{clip_id}/create", json={}, headers=h)).json()
    assert c["status"] == "failed" and "offline" in c["error_message"]

    async with app.state.sessionmaker() as db:
        s = await db.scalar(select(Streamer).where(Streamer.username == "streamerone"))
        s.is_live = False
        await db.commit()
    r = await client.post(f"/api/v1/clips/{clip_id}/retry", json={}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "stream_offline"


async def test_review_transitions(ctx) -> None:
    app, client, h = ctx
    cid = await _candidate(app, client, h)
    assert (await client.post(f"/api/v1/highlights/{cid}/reject", headers=h)).json()["highlight"]["status"] == "rejected"
    assert (await client.post(f"/api/v1/highlights/{cid}/reject", headers=h)).status_code == 409
    reopened = await client.patch(f"/api/v1/highlights/{cid}", json={"status": "pending_review", "start_offset_sec": 3560, "end_offset_sec": 3600, "category": "exciting_moment"}, headers=h)
    assert reopened.status_code == 200 and reopened.json()["status"] == "pending_review"
    assert reopened.json()["start_offset_sec"] == 3560 and reopened.json()["category"] == "exciting_moment"
    bad = await client.patch(f"/api/v1/highlights/{cid}", json={"start_offset_sec": 3600, "end_offset_sec": 3500}, headers=h)
    assert bad.status_code == 400
    assert (await client.patch(f"/api/v1/highlights/{cid}", json={"status": "published"}, headers=h)).status_code == 422


async def test_kick_manual_workflow_and_publishing(ctx) -> None:
    app, client, h = ctx
    cid = await _candidate(app, client, h, platform="kick", username="kickstar")
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    assert clip["status"] == "unsupported" and "https://kick.com/kickstar" in clip["error_message"]
    r = await client.post(f"/api/v1/clips/{clip['id']}/create", json={}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "requires_manual_action"

    bad = await client.patch(f"/api/v1/clips/{clip['id']}", json={"platform_clip_url": "https://evil.example/clip"}, headers=h)
    assert bad.status_code == 400
    ok = (await client.patch(f"/api/v1/clips/{clip['id']}", json={"platform_clip_url": "https://kick.com/kickstar/clips/clip_01", "title": "  Funny fail  ", "aspect_ratio": "1:1"}, headers=h)).json()
    assert ok["status"] == "created" and ok["source"] == "manual" and ok["title"] == "Funny fail" and ok["aspect_ratio"] == "1:1"

    exp = await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    assert exp.status_code == 409 and exp.json()["error"]["code"] == "media_unavailable"

    # Publishing is never implicit.
    assert (await client.post(f"/api/v1/clips/{clip['id']}/publish", json={}, headers=h)).status_code == 422
    assert (await client.post(f"/api/v1/clips/{clip['id']}/publish", json={"confirm": False}, headers=h)).status_code == 422
    pub = (await client.post(f"/api/v1/clips/{clip['id']}/publish", json={"confirm": True, "published_url": "https://www.tiktok.com/@me/video/1"}, headers=h)).json()
    assert pub["status"] == "published" and pub["published_at"] and pub["published_url"].startswith("https://www.tiktok.com/")
    assert (await client.post(f"/api/v1/clips/{clip['id']}/publish", json={"confirm": True}, headers=h)).status_code == 409


async def test_other_users_cannot_act(ctx) -> None:
    app, client, h = ctx
    cid = await _candidate(app, client, h)
    clip_id = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]["id"]
    other = await client.post("/api/v1/auth/register", json={"email": "o@example.com", "username": "oo", "password": "long password"})
    oh = {"Authorization": f"Bearer {other.json()['access_token']}"}
    for method, path in (("POST", f"/api/v1/highlights/{cid}/approve"), ("POST", f"/api/v1/highlights/{cid}/reject"),
                         ("POST", f"/api/v1/clips/{clip_id}/create"), ("PATCH", f"/api/v1/clips/{clip_id}"),
                         ("POST", f"/api/v1/clips/{clip_id}/publish")):
        body = {"confirm": True} if path.endswith("publish") else {}
        assert (await client.request(method, path, json=body, headers=oh)).status_code == 404, path


async def test_auto_capture_at_detection_time(ctx, tw: FakeTwitch) -> None:
    app, client, h = ctx
    await _connect_twitch(client, h)
    assert (await client.post("/api/v1/streamers", json={"platform": "twitch", "username": "streamerone"}, headers=h)).status_code == 201
    async with app.state.sessionmaker() as db:
        user = await db.scalar(select(User))
        streamer = await db.scalar(select(Streamer))
        now = datetime.now(UTC)
        db.add(MonitoringSession(user_id=user.id, streamer_id=streamer.id, platform="twitch", status="active",
                                 started_at=now, broadcast_started_at=now - timedelta(minutes=5)))
        await db.commit()
        sid = streamer.id
    draft = CandidateDraft(Platform.TWITCH, "101", now - timedelta(seconds=25), now - timedelta(seconds=10), now - timedelta(seconds=15),
                           score=88, confidence=0.9, category="funny_moment", reasons=["'KEKW' used by 40 chatters"],
                           signal_breakdown={"chat": 88}, strictness=Strictness.LOW, events=[])
    weak = CandidateDraft(Platform.TWITCH, "101", now, now, now, score=40, confidence=0.5, category="audience_reaction",
                          reasons=["x"], signal_breakdown={"chat": 40}, strictness=Strictness.LOW, events=[])
    chat = app.state.chat
    async with app.state.sessionmaker() as db:
        await chat._persist(db, draft, sid)
        await chat._persist(db, weak, sid)  # below the default minimum score (60): not captured
        await db.commit()
    for clip_id in chat._pending_capture:
        await app.state.clip_worker.request(clip_id)
    async with app.state.sessionmaker() as db:
        clips = (await db.scalars(select(Clip))).all()
        cands = (await db.scalars(select(HighlightCandidate))).all()
    assert len(cands) == 2 and len(clips) == 1
    assert clips[0].source == "auto" and clips[0].status == "created" and clips[0].platform_clip_url
    assert all(c.status == "pending_review" for c in cands), "auto-capture never approves or publishes"

    # Opt out → no capture.
    await client.patch("/api/v1/settings", json={"clips": {"autoCreatePlatformClips": False}}, headers=h)
    chat._pending_capture.clear()
    async with app.state.sessionmaker() as db:
        await chat._persist(db, draft, sid)
        await db.commit()
    assert chat._pending_capture == []
