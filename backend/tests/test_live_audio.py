"""Phase 7 live tab audio: loudness buffer, detection enrichment and the ingest API."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.detection.live_audio import LiveAudioBuffer
from app.detection.models import ChatMessage
from app.domain.enums import Platform
from app.models import HighlightCandidate, MonitoringSession, Streamer, User, UserSettings, UserStreamer
from tests.chat_sim import ChatSim
from tests.test_chat_collectors import stack  # noqa: F401 - shared fixture (Kick chat + webhook stack)

T = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


def _quiet_then_loud(start: datetime, seconds: int, loud: range = range(0), quiet_db: float = -40.0, loud_db: float = -22.0):  # type: ignore[no-untyped-def]
    return [(start + timedelta(seconds=i), loud_db if i in loud else quiet_db) for i in range(seconds)]


# --- buffer ---------------------------------------------------------------------------------
def test_needs_history_before_judging_a_window() -> None:
    b = LiveAudioBuffer()
    b.add(_quiet_then_loud(T, 20), T + timedelta(seconds=20))
    assert b.window_score(T + timedelta(seconds=30), T + timedelta(seconds=40)) is None  # 20 s isn't "normal" yet
    assert b.status(T + timedelta(seconds=20))["audio_warming_up"] is True


def test_loud_window_scores_against_the_streams_own_baseline() -> None:
    b = LiveAudioBuffer()
    b.add(_quiet_then_loud(T, 200, loud=range(150, 160)), T + timedelta(seconds=200))
    loud = b.window_score(T + timedelta(seconds=160), T + timedelta(seconds=170))  # lead covers 145–170
    quiet = b.window_score(T + timedelta(seconds=100), T + timedelta(seconds=110))
    assert loud is not None and quiet is not None
    assert loud == (100.0, 18.0) and quiet[0] == 0.0  # 18 dB above the -40 dB baseline → capped at 100
    assert b.window_score(T + timedelta(seconds=400), T + timedelta(seconds=410)) is None  # not measured


def test_rejects_old_and_future_samples_and_clamps() -> None:
    b = LiveAudioBuffer()
    now = T + timedelta(minutes=30)
    n = b.add([(T, -30.0), (now + timedelta(minutes=1), -30.0), (now, 12.0), (now - timedelta(seconds=1), -500.0)], now)
    assert n == 2 and len(b) == 2
    s = b.status(now)
    assert s["audio_state"] == "receiving" and s["audio_level_db"] == 0.0
    assert b.status(now + timedelta(seconds=30))["audio_state"] == "stale"
    assert LiveAudioBuffer().status(now) == {"audio_state": "off"}


# --- live detection with tab audio ----------------------------------------------------------
async def _watch(app, user_id: int, *, live_since: datetime) -> tuple[int, int]:  # type: ignore[no-untyped-def]
    async with app.state.sessionmaker() as db:
        s = await db.scalar(select(Streamer).where(Streamer.platform_user_id == "501"))
        if s is None:
            s = Streamer(platform="kick", platform_user_id="501", username="KickStar", display_name="KickStar",
                         is_live=True, monitoring_enabled=True, stream_started_at=live_since)
            db.add(s)
            await db.flush()
        db.add(UserStreamer(user_id=user_id, streamer_id=s.id, monitoring_enabled=True))
        db.add(UserSettings(user_id=user_id, settings={"detection": {"sensitivity": "high"}}))
        sess = MonitoringSession(user_id=user_id, streamer_id=s.id, platform="kick", status="active",
                                 started_at=live_since, broadcast_started_at=live_since)
        db.add(sess)
        await db.commit()
        return s.id, sess.id


async def test_live_highlights_carry_measured_tab_audio(stack) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app, client, _, _ = stack
    async with app.state.sessionmaker() as db:
        u = User(email="ed@example.com", username="ed", hashed_password=None)
        db.add(u)
        await db.commit()
        uid = u.id
    sim = ChatSim(platform=Platform.KICK)
    sim.now = datetime.now(UTC).replace(second=0, microsecond=0) + timedelta(minutes=10)
    streamer_id, _ = await _watch(app, uid, live_since=sim.now - timedelta(minutes=30))
    chat = app.state.chat
    await chat.sync()

    def kick(msgs):  # type: ignore[no-untyped-def]
        return [ChatMessage(Platform.KICK, "501", m.user_id, m.user_login, m.text, m.emotes, m.received_at) for m in msgs]

    start = sim.now
    timeline = kick(sim.normal(180)) + kick(sim.burst(12, users=40, text="KEKW", emotes=("KEKW",))) + kick(sim.normal(60))
    # The streamer's audio is quiet, then loud during the 12 s burst (180–192 s).
    audio = _quiet_then_loud(start, 252, loud=range(176, 192))
    t, i, j = start, 0, 0
    while t <= sim.now:
        while i < len(timeline) and timeline[i].received_at < t:
            chat.ingest(timeline[i])
            i += 1
        batch = [s for s in audio[j:] if s[0] < t]
        j += len(batch)
        chat.ingest_audio(streamer_id, batch, t)
        await chat.analyze(t)
        t += timedelta(seconds=5)

    async with app.state.sessionmaker() as db:
        [c] = (await db.scalars(select(HighlightCandidate))).all()
    b = c.signal_breakdown
    assert b["audio_source"] == "live_tab" and b["audio"] == 100.0 and b["active_signals"] == ["chat", "audio"]
    assert b["chat_only_score"] == b["chat"] and c.score >= 99  # chat and audio agree → stays at the top
    assert "Stream audio 18.0 dB louder than usual" in c.reasons

    act = chat.activity(streamer_id, sim.now)
    assert act["audio_state"] == "receiving" and act["audio_warming_up"] is False


# --- ingest API -----------------------------------------------------------------------------
async def test_audio_api_resolves_the_session_and_corrects_the_clock(stack) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app, client, _, _ = stack
    r = await client.post("/api/v1/auth/register", json={"email": "a@example.com", "username": "aa", "password": "long password"})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    uid = (await client.get("/api/v1/auth/me", headers=h)).json()["id"]
    now = datetime.now(UTC)
    _, sess_id = await _watch(app, uid, live_since=now - timedelta(minutes=30))

    browser = now - timedelta(hours=2)  # a browser clock that is two hours off
    body = {"platform": "kick", "channel": "kickstar", "sent_at": browser.isoformat(),
            "samples": [{"t": (browser - timedelta(seconds=5 - k)).isoformat(), "db": -30.5} for k in range(5)]}

    # Not tracked yet (no chat sync since the session started) → nothing kept, but the session is found.
    first = await client.post("/api/v1/monitoring/audio", json=body, headers=h)
    assert first.status_code == 200 and first.json()["accepted"] == 0 and first.json()["audio_state"] == "off"

    await app.state.chat.sync()
    ok = (await client.post("/api/v1/monitoring/audio", json=body, headers=h)).json()
    assert ok == {"session_id": sess_id, "streamer_id": ok["streamer_id"], "accepted": 5, "audio_state": "receiving"}

    act = (await client.get(f"/api/v1/monitoring/{sess_id}/activity", headers=h)).json()
    assert act["audio_state"] == "receiving" and act["audio_level_db"] == -30.5 and act["audio_warming_up"] is True

    missing = await client.post("/api/v1/monitoring/audio", json={**body, "channel": "someoneelse"}, headers=h)
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_monitoring"
    bad = await client.post("/api/v1/monitoring/audio", json={**body, "channel": "../x"}, headers=h)
    assert bad.status_code == 422
    too_many = await client.post("/api/v1/monitoring/audio", json={**body, "samples": body["samples"] * 25}, headers=h)
    assert too_many.status_code == 422

    # Another account can't feed audio into this user's session.
    o = await client.post("/api/v1/auth/register", json={"email": "o@example.com", "username": "oo", "password": "long password"})
    oh = {"Authorization": f"Bearer {o.json()['access_token']}"}
    assert (await client.post("/api/v1/monitoring/audio", json=body, headers=oh)).status_code == 404
    assert (await client.post("/api/v1/monitoring/audio", json=body)).status_code == 401
