from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx

from app.models import Clip, HighlightCandidate, MonitoringSession, StreamEvent
from tests.conftest import register


async def test_health(client: httpx.AsyncClient) -> None:
    for path in ("/health", "/api/v1/health"):
        r = await client.get(path)
        assert r.status_code == 200
        assert r.json()["status"] == "ok" and r.json()["database"] == "ok"


async def test_openapi_docs_available(client: httpx.AsyncClient) -> None:
    assert (await client.get("/docs")).status_code == 200
    spec = (await client.get("/openapi.json")).json()
    assert "/api/v1/streamers" in spec["paths"]


async def test_unknown_route_uses_error_envelope(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


async def _seed(app, user_id: int) -> dict[str, int]:
    """Persist one session/event/candidate/clip directly (detection arrives in Phase 5)."""
    from app.models import Streamer

    now = datetime.now(UTC)
    async with app.state.sessionmaker() as db:
        s = Streamer(platform="twitch", platform_user_id=f"u{user_id}", username=f"s{user_id}", display_name=f"S{user_id}")
        db.add(s)
        await db.flush()
        sess = MonitoringSession(user_id=user_id, streamer_id=s.id, platform="twitch", status="active", started_at=now)
        db.add(sess)
        await db.flush()
        db.add(StreamEvent(session_id=sess.id, streamer_id=s.id, event_type="chat_spike", confidence=0.9, event_metadata={"unique_users": 40}))
        hi = HighlightCandidate(
            user_id=user_id, session_id=sess.id, streamer_id=s.id, platform="twitch", timestamp=now - timedelta(minutes=5),
            score=82, confidence=0.8, category="funny_moment", reasons=["Chat volume 4.2x baseline"], status="pending_review",
        )
        lo = HighlightCandidate(
            user_id=user_id, session_id=sess.id, streamer_id=s.id, platform="twitch", timestamp=now - timedelta(days=2),
            score=40, confidence=0.5, category="other", reasons=[], status="rejected",
        )
        db.add_all([hi, lo])
        await db.flush()
        db.add(Clip(candidate_id=hi.id, user_id=user_id, platform="twitch", status="creation_requested"))
        await db.commit()
        return {"session": sess.id, "high": hi.id, "low": lo.id}


async def test_activity_reads_are_filtered_and_user_scoped(client: httpx.AsyncClient, app) -> None:
    me = await register(client)
    other = await register(client, "other@example.com")
    h = {"Authorization": f"Bearer {me['access_token']}"}
    mine = await _seed(app, me["user"]["id"])
    theirs = await _seed(app, other["user"]["id"])

    sessions = (await client.get("/api/v1/monitoring", headers=h)).json()
    assert sessions["total"] == 1 and sessions["items"][0]["streamer_display_name"] == f"S{me['user']['id']}"
    events = (await client.get(f"/api/v1/monitoring/{mine['session']}/events", headers=h)).json()
    assert events["total"] == 1 and events["items"][0]["metadata"] == {"unique_users": 40}

    all_h = (await client.get("/api/v1/highlights", headers=h)).json()
    assert all_h["total"] == 2
    assert all_h["items"][0]["id"] == mine["high"]  # newest first
    assert (await client.get("/api/v1/highlights", params={"min_score": 60}, headers=h)).json()["total"] == 1
    assert (await client.get("/api/v1/highlights", params={"status": "rejected"}, headers=h)).json()["total"] == 1
    since = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    assert (await client.get("/api/v1/highlights", params={"date_from": since}, headers=h)).json()["total"] == 1
    assert (await client.get("/api/v1/highlights", params={"status": "bogus"}, headers=h)).status_code == 422

    clips = (await client.get("/api/v1/clips", headers=h)).json()
    assert clips["total"] == 1 and clips["items"][0]["platform_clip_url"] is None

    # Other user's records are invisible.
    for path in (
        f"/api/v1/monitoring/{theirs['session']}",
        f"/api/v1/monitoring/{theirs['session']}/events",
        f"/api/v1/highlights/{theirs['high']}",
    ):
        assert (await client.get(path, headers=h)).status_code == 404, path


async def test_settings_defaults_patch_and_validation(client: httpx.AsyncClient, auth_headers) -> None:
    d = (await client.get("/api/v1/settings", headers=auth_headers)).json()
    assert d["monitoring"]["intervalMinutes"] == 2 and d["detection"]["sensitivity"] == "medium"

    r = await client.patch(
        "/api/v1/settings",
        json={"detection": {"sensitivity": "high", "customKeywords": ["Clip it", "clip it", " "]}, "locale": {"timeZone": "Europe/Paris"}},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["detection"]["sensitivity"] == "high"
    assert s["detection"]["customKeywords"] == ["Clip it"]
    assert s["detection"]["minHighlightScore"] == 60  # untouched values survive
    assert (await client.get("/api/v1/settings", headers=auth_headers)).json() == s

    for bad in (
        {"monitoring": {"intervalMinutes": 0}},
        {"detection": {"keywordLanguages": ["xx"]}},
        {"locale": {"timeZone": "Mars/Base"}},
        {"unknown": True},
    ):
        r = await client.patch("/api/v1/settings", json=bad, headers=auth_headers)
        assert r.status_code == 400, bad
        assert r.json()["error"]["code"] == "validation_error"
