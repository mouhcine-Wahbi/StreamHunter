"""Twitch EventSub WebSocket client, Kick webhook verification, and the chat manager."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from pydantic import SecretStr
from sqlalchemy import select
from websockets.asyncio.server import serve

from app.config import Settings
from app.db.base import Base
from app.detection.models import ChatMessage
from app.domain.enums import Platform
from app.integrations.kick.adapter import KickAdapter
from app.integrations.kick.chat import KickWebhookVerifier, parse_chat_event
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.chat import TwitchChatConnection
from app.main import create_app
from app.models import HighlightCandidate, MonitoringSession, StreamEvent, Streamer, User, UserSettings, UserStreamer
from tests.chat_sim import ChatSim
from tests.fakes import FakePlatform, channel
from tests.platform_mocks import FakeKick, transport


# --- Twitch EventSub over a real local WebSocket ------------------------------------------
class FakeEventSub:
    """Minimal EventSub WebSocket server: welcome, then scripted messages per connection."""

    def __init__(self) -> None:
        self.connections = 0
        self.scripts: list[list[dict]] = []
        self.port = 0
        self.reconnect_path_hits = 0

    async def handler(self, ws) -> None:  # type: ignore[no-untyped-def]
        self.connections += 1
        if ws.request.path == "/reconnected":
            self.reconnect_path_hits += 1
        n = self.connections
        await ws.send(json.dumps({"metadata": {"message_type": "session_welcome"},
                                  "payload": {"session": {"id": f"session-{n}", "keepalive_timeout_seconds": 1}}}))
        for msg in self.scripts.pop(0) if self.scripts else []:
            await asyncio.sleep(0.05)
            await ws.send(json.dumps(msg))
        await ws.wait_closed()  # then go silent (keepalive timeout triggers reconnect)


def chat_note(broadcaster: str, chatter: str, text: str, emotes: list[str] = []) -> dict:  # noqa: B006
    frags = [{"type": "text", "text": text}] + [{"type": "emote", "text": e, "emote": {"id": "1"}} for e in emotes]
    return {"metadata": {"message_type": "notification"},
            "payload": {"subscription": {"type": "channel.chat.message"},
                        "event": {"broadcaster_user_id": broadcaster, "chatter_user_id": chatter,
                                  "chatter_user_login": f"user{chatter}", "message": {"text": text, "fragments": frags}}}}


@pytest.fixture
async def eventsub() -> AsyncIterator[FakeEventSub]:
    fake = FakeEventSub()
    async with serve(fake.handler, "127.0.0.1", 0) as server:
        fake.port = server.sockets[0].getsockname()[1]
        yield fake


async def test_twitch_eventsub_flow(eventsub: FakeEventSub) -> None:
    posted: list[dict] = []
    deleted: list[str] = []

    def helix(req: httpx.Request) -> httpx.Response:
        if req.method == "POST":
            body = json.loads(req.content)
            posted.append(body)
            assert req.headers["Authorization"] == "Bearer user-tok" and req.headers["Client-Id"] == "cid"
            return httpx.Response(202, json={"data": [{"id": f"sub-{len(posted)}", "status": "enabled"}]})
        deleted.append(req.url.params["id"])
        return httpx.Response(204)

    eventsub.scripts = [
        [chat_note("b1", "7", "KEKW KEKW", ["KEKW"]),
         {"metadata": {"message_type": "session_reconnect"},
          "payload": {"session": {"reconnect_url": f"ws://127.0.0.1:{eventsub.port}/reconnected"}}}],
        [chat_note("b1", "8", "after reconnect")],
        [{"metadata": {"message_type": "revocation"},
          "payload": {"subscription": {"status": "authorization_revoked", "condition": {"broadcaster_user_id": "b1"}}}}],
    ]
    got: list[ChatMessage] = []
    errors: list[tuple[str, str]] = []

    async def no_sleep(_: float) -> None:
        return None

    async with httpx.AsyncClient(transport=transport(helix)) as http:
        conn = TwitchChatConnection(
            client_id="cid", token_user_id="9001", token=lambda: asyncio.sleep(0, "user-tok"),
            on_message=got.append, on_channel_error=lambda b, r: errors.append((b, r)), http=http,
            ws_url=f"ws://127.0.0.1:{eventsub.port}/ws", sleep=no_sleep, keepalive_grace=0.3,
        )
        await conn.set_channels({"b1"})
        conn.start()
        for _ in range(100):
            await asyncio.sleep(0.05)
            if errors:
                break
        await conn.stop()

    # Subscribed with the session id and the token owner as user_id.
    assert posted[0]["type"] == "channel.chat.message" and posted[0]["version"] == "1"
    assert posted[0]["condition"] == {"broadcaster_user_id": "b1", "user_id": "9001"}
    assert posted[0]["transport"] == {"method": "websocket", "session_id": "session-1"}
    # Messages normalized, including emotes from fragments.
    assert [m.text for m in got[:2]] == ["KEKW KEKW", "after reconnect"]
    assert got[0].emotes == ("KEKW",) and got[0].platform == Platform.TWITCH and got[0].user_login == "user7"
    # session_reconnect: moved to the new URL without resubscribing.
    assert eventsub.reconnect_path_hits == 1
    # keepalive timeout → new session → resubscribed with the new session id; then revocation reported.
    assert any(p["transport"]["session_id"] == "session-3" for p in posted)
    assert errors and errors[0][0] == "b1" and "authorization_revoked" in errors[0][1]


# --- Kick webhooks ----------------------------------------------------------------------
def _keypair() -> tuple[rsa.RSAPrivateKey, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return key, pem


def _signed(key: rsa.RSAPrivateKey, body: bytes, *, msg_id: str = "m1", ts: datetime | None = None,
            event: str = "chat.message.sent") -> dict[str, str]:
    stamp = (ts or datetime.now(UTC)).isoformat().replace("+00:00", "Z")
    sig = key.sign(msg_id.encode() + b"." + stamp.encode() + b"." + body, padding.PKCS1v15(), hashes.SHA256())
    return {"Kick-Event-Message-Id": msg_id, "Kick-Event-Message-Timestamp": stamp,
            "Kick-Event-Signature": base64.b64encode(sig).decode(), "Kick-Event-Type": event,
            "Kick-Event-Version": "1", "Kick-Event-Subscription-Id": "sub-1"}


async def test_kick_verifier() -> None:
    key, pem = _keypair()
    old_key, old_pem = _keypair()
    served = [old_pem, pem]  # first fetch returns a rotated-out key

    async def fetch() -> str:
        return served.pop(0) if len(served) > 1 else served[0]

    v = KickWebhookVerifier(fetch)
    body = b'{"x":1}'
    assert await v.verify(_signed(key, body), body) == (True, "ok")  # refetched key after mismatch
    assert (await v.verify(_signed(key, body), body))[1] == "duplicate message"
    assert (await v.verify(_signed(old_key, body, msg_id="m2"), body))[1] == "invalid signature"
    assert (await v.verify(_signed(key, b"tampered", msg_id="m3"), body))[1] == "invalid signature"
    stale = _signed(key, body, msg_id="m4", ts=datetime.now(UTC) - timedelta(minutes=10))
    assert (await v.verify(stale, body))[1] == "timestamp outside the allowed window"
    assert (await v.verify({}, body))[1] == "missing signature headers"


def test_kick_chat_payload_parsing() -> None:
    msg = parse_chat_event(
        {"message_id": "x", "broadcaster": {"user_id": 501, "username": "kickstar"},
         "sender": {"user_id": 42, "username": "Viewer"}, "content": "no way [emote:37226:KEKW] [emote:1:LULW]",
         "created_at": "2026-11-15T12:00:00Z"},
        datetime.now(UTC),
    )
    assert msg and msg.broadcaster_id == "501" and msg.user_id == "42" and msg.user_login == "Viewer"
    assert msg.emotes == ("KEKW", "LULW") and msg.text == "no way KEKW LULW"
    assert parse_chat_event({"content": "x"}, datetime.now(UTC)) is None


# --- chat manager + webhook route, end to end -------------------------------------------
@pytest.fixture
async def stack(tmp_path) -> AsyncIterator[tuple]:  # type: ignore[type-arg]
    key, pem = _keypair()
    kk = FakeKick(public_key_pem=pem)
    settings = Settings(
        _env_file=None, app_env="test", scheduler_enabled=False,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'chat.db'}",
        token_encryption_key=SecretStr(Fernet.generate_key().decode()),
        kick_client_id="kick-client", kick_client_secret=SecretStr("kick-secret"),
        kick_webhook_public_url="https://hooks.example.test",
    )
    twitch = FakePlatform(Platform.TWITCH, [channel(Platform.TWITCH, "1001", "alpha")])
    registry = PlatformRegistry({Platform.TWITCH: twitch, Platform.KICK: KickAdapter(settings, transport=transport(kk.handler))})
    app = create_app(settings, registry=registry)
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield app, client, kk, key
    await app.state.chat.stop()
    await app.state.engine.dispose()


async def _user_session(app, email: str, *, sensitivity: str, live_since: datetime) -> tuple[int, int]:  # type: ignore[no-untyped-def]
    async with app.state.sessionmaker() as db:
        u = User(email=email, username=email.split("@")[0], hashed_password=None)
        db.add(u)
        s = await db.scalar(select(Streamer).where(Streamer.platform_user_id == "501"))
        if s is None:
            s = Streamer(platform="kick", platform_user_id="501", username="kickstar", display_name="KickStar",
                         is_live=True, monitoring_enabled=True, stream_started_at=live_since)
            db.add(s)
        await db.flush()
        db.add(UserStreamer(user_id=u.id, streamer_id=s.id, monitoring_enabled=True))
        db.add(UserSettings(user_id=u.id, settings={"detection": {"sensitivity": sensitivity}, "clips": {"preRollSeconds": 20, "postRollSeconds": 10}}))
        sess = MonitoringSession(user_id=u.id, streamer_id=s.id, platform="kick", status="active",
                                 started_at=live_since, broadcast_started_at=live_since)
        db.add(sess)
        await db.commit()
        return u.id, sess.id


async def test_kick_webhook_to_candidates_per_user_sensitivity(stack) -> None:  # type: ignore[no-untyped-def]
    app, client, kk, key = stack
    sim = ChatSim(platform=Platform.KICK)
    # The signed webhook below is stamped with the real clock. Start the simulated chat after it
    # (else every message is "late" and lands in the webhook's bucket) and beyond the 5-min baseline
    # window (else that lone message looks like quiet history). Minute-aligned like T0.
    sim.now = datetime.now(UTC).replace(second=0, microsecond=0) + timedelta(minutes=10)
    live_since = sim.now - timedelta(minutes=30)
    strict_user, strict_sess = await _user_session(app, "strict@example.com", sensitivity="low", live_since=live_since)
    eager_user, eager_sess = await _user_session(app, "eager@example.com", sensitivity="high", live_since=live_since)

    chat = app.state.chat
    await chat.sync()
    assert list(kk.subscriptions.values())[0] == {"broadcaster_user_id": 501, "events": [{"name": "chat.message.sent", "version": 1}], "method": "webhook"}
    assert chat.activity(1, sim.now)["chat_state"] == "connecting"

    # One real signed webhook delivery through the API.
    body = json.dumps({"broadcaster": {"user_id": 501}, "sender": {"user_id": 1, "username": "viewer1"},
                       "content": "hello [emote:1:KEKW]"}).encode()
    r = await client.post("/api/v1/webhooks/kick", content=body, headers=_signed(key, body))
    assert r.status_code == 200 and r.json() == {"ok": True, "accepted": True}
    bad = await client.post("/api/v1/webhooks/kick", content=body, headers={**_signed(key, body, msg_id="z"), "Kick-Event-Signature": base64.b64encode(b"x" * 256).decode()})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_signature"

    # Then simulate a stream's worth of chat directly (faster than signing thousands of webhooks).
    def kick_msgs(msgs):  # type: ignore[no-untyped-def]
        for m in msgs:
            yield ChatMessage(Platform.KICK, "501", m.user_id, m.user_login, m.text, m.emotes, m.received_at)

    timeline = list(kick_msgs(sim.normal(180))) + list(kick_msgs(sim.burst(10, users=6, text="omg"))) + list(kick_msgs(sim.normal(60)))
    t = timeline[0].received_at
    i = 0
    while t <= sim.now:
        while i < len(timeline) and timeline[i].received_at < t:
            chat.ingest(timeline[i]); i += 1
        await chat.analyze(t)
        t += timedelta(seconds=5)
    big = list(kick_msgs(sim.burst(12, users=40, text="KEKW", emotes=("KEKW",)))) + list(kick_msgs(sim.normal(60)))
    i = 0
    while t <= sim.now:
        while i < len(big) and big[i].received_at < t:
            chat.ingest(big[i]); i += 1
        await chat.analyze(t)
        t += timedelta(seconds=5)

    async with app.state.sessionmaker() as db:
        cands = (await db.scalars(select(HighlightCandidate).order_by(HighlightCandidate.id))).all()
        events = (await db.scalars(select(StreamEvent))).all()
    eager = [c for c in cands if c.user_id == eager_user]
    strict = [c for c in cands if c.user_id == strict_user]
    assert len(eager) == 2, "high sensitivity sees the small 'omg' wave and the big KEKW wave"
    assert len(strict) == 1 and strict[0].category == "funny_moment", "low sensitivity only the big one"
    c = strict[0]
    assert c.status == "pending_review" and c.score >= 60 and c.reasons
    assert c.signal_breakdown["audio"] is None and c.signal_breakdown["offsets_approximate"] is True
    # Offsets are relative to the broadcast start, include the 20 s pre-roll, and are ~30+ min in.
    assert c.start_offset_sec is not None and c.end_offset_sec is not None
    assert 30 * 60 < c.start_offset_sec < c.end_offset_sec < 40 * 60
    assert {e.event_type for e in events} >= {"chat_spike", "emote_wave"}
    assert all("text" not in (e.event_metadata or {}) for e in events)  # no raw chat stored

    # API + heartbeat notification for the user.
    tok = (await client.post("/api/v1/auth/register", json={"email": "api@example.com", "username": "api", "password": "long password"})).json()
    act = await client.get(f"/api/v1/monitoring/{strict_sess}/activity", headers={"Authorization": f"Bearer {tok['access_token']}"})
    assert act.status_code == 404  # another user's session

    # Session ends → collector stops and Kick subscription is removed.
    async with app.state.sessionmaker() as db:
        for sid in (strict_sess, eager_sess):
            (await db.get(MonitoringSession, sid)).status = "ended"
        await db.commit()
    await chat.sync()
    assert chat.tracked == {} and kk.deleted_subscriptions == ["sub-1"]


async def test_chat_unavailable_reasons_are_reported_on_sessions(stack) -> None:  # type: ignore[no-untyped-def]
    app, _, _, _ = stack
    # A Twitch session without any connected Twitch account.
    async with app.state.sessionmaker() as db:
        u = User(email="t@example.com", username="t", hashed_password=None)
        s = Streamer(platform="twitch", platform_user_id="1001", username="alpha", display_name="Alpha", is_live=True, monitoring_enabled=True)
        db.add_all([u, s])
        await db.flush()
        db.add(UserStreamer(user_id=u.id, streamer_id=s.id))
        db.add(MonitoringSession(user_id=u.id, streamer_id=s.id, platform="twitch", status="active", started_at=datetime.now(UTC)))
        await db.commit()
    await app.state.chat.sync()
    async with app.state.sessionmaker() as db:
        sess = await db.scalar(select(MonitoringSession).where(MonitoringSession.platform == "twitch"))
    assert sess.error_message and "Twitch" in sess.error_message
