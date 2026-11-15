"""Browser-leased monitoring: lease, polling cadence, session transitions, retention."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select, update

from app.models import MonitoringLease, MonitoringSession, OAuthState, StreamEvent, Streamer
from app.monitoring.retention import sweep
from tests.conftest import register
from tests.fakes import FakePlatform

HB = {"client": "chrome-extension", "interval_seconds": 120}


async def _sessions(app) -> list[MonitoringSession]:
    async with app.state.sessionmaker() as db:
        return list((await db.scalars(select(MonitoringSession).order_by(MonitoringSession.id))).unique())


async def _age_checks(app, minutes: int = 10) -> None:
    """Pretend the last status check happened a while ago so the next cycle polls."""
    async with app.state.sessionmaker() as db:
        await db.execute(update(Streamer).values(status_checked_at=datetime.now(UTC) - timedelta(minutes=minutes)))
        await db.commit()


async def _expire_lease(app) -> None:
    async with app.state.sessionmaker() as db:
        await db.execute(update(MonitoringLease).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        await db.commit()


async def _add(client, h, username="bravo") -> dict:
    r = await client.post("/api/v1/streamers", json={"platform": "twitch", "username": username}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_heartbeat_grants_lease_and_requires_auth(client: httpx.AsyncClient, auth_headers, app) -> None:
    assert (await client.post("/api/v1/monitoring/heartbeat", json=HB)).status_code == 401
    r = await client.post("/api/v1/monitoring/heartbeat", json=HB, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["started"] is True and body["interval_seconds"] == 120
    expires = datetime.fromisoformat(body["lease_expires_at"].replace("Z", "+00:00"))
    # TTL = max(360 s, 3 × 120 + 60 = 420 s)
    assert timedelta(seconds=410) < expires - datetime.now(UTC) <= timedelta(seconds=420)
    again = (await client.post("/api/v1/monitoring/heartbeat", json=HB, headers=auth_headers)).json()
    assert again["started"] is False
    st = (await client.get("/api/v1/monitoring/status", headers=auth_headers)).json()
    assert st["lease_active"] is True


async def test_heartbeat_validates_interval(client, auth_headers) -> None:
    r = await client.post("/api/v1/monitoring/heartbeat", json={"interval_seconds": 5}, headers=auth_headers)
    assert r.status_code == 422


async def test_full_lifecycle_live_offline(client, auth_headers, app, fake_twitch: FakePlatform) -> None:
    s = await _add(client, auth_headers)  # "bravo" (id 1002) is offline initially
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    assert await _sessions(app) == []

    # Goes live → next cycle opens a session and reports a notification.
    fake_twitch.set_live("1002", True)
    await _age_checks(app)
    await app.state.monitoring.run_cycle()
    [sess] = await _sessions(app)
    assert sess.status == "active" and sess.broadcast_started_at is not None
    hb = (await client.post("/api/v1/monitoring/heartbeat", json=HB, headers=auth_headers)).json()
    assert hb["active_sessions"] == 1 and hb["live_count"] == 1
    assert [n["type"] for n in hb["notifications"]] == ["streamer_live"]
    assert hb["notifications"][0]["streamer_display_name"] == "Bravo"
    # `since` filters out notifications already delivered.
    hb2 = (await client.post("/api/v1/monitoring/heartbeat", json={**HB, "since": hb["server_time"]}, headers=auth_headers)).json()
    assert hb2["notifications"] == []

    # Goes offline → session ended, offline event recorded.
    fake_twitch.set_live("1002", False)
    await _age_checks(app)
    await app.state.monitoring.run_cycle()
    [sess] = await _sessions(app)
    assert sess.status == "ended" and sess.ended_at is not None
    events = (await client.get(f"/api/v1/monitoring/{sess.id}/events", headers=auth_headers)).json()
    assert {e["event_type"] for e in events["items"]} == {"stream_online", "stream_offline"}
    assert (await client.get(f"/api/v1/streamers/{s['id']}", headers=auth_headers)).json()["is_live"] is False


async def test_lease_expiry_pauses_and_heartbeat_resumes_same_broadcast(client, auth_headers, app, fake_twitch) -> None:
    await _add(client, auth_headers)
    fake_twitch.set_live("1002", True)
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)  # immediate cycle
    [sess] = await _sessions(app)
    assert sess.status == "active"

    # Browser closed: lease runs out → scheduler pauses, and stops polling.
    await _expire_lease(app)
    await _age_checks(app)
    fake_twitch.calls.clear()
    await app.state.monitoring.run_cycle()
    [sess] = await _sessions(app)
    assert sess.status == "paused"
    assert not any(c[0] == "live_status" for c in fake_twitch.calls), "must not poll without a lease"

    # Chrome back, same broadcast → the same session resumes.
    await client.post("/api/v1/monitoring/heartbeat", json=HB, headers=auth_headers)
    [sess] = await _sessions(app)
    assert sess.status == "active"


async def test_new_broadcast_after_pause_opens_new_session(client, auth_headers, app, fake_twitch) -> None:
    await _add(client, auth_headers)
    fake_twitch.set_live("1002", True, started=datetime(2026, 11, 15, 5, 0, tzinfo=UTC))
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    await client.post("/api/v1/monitoring/stop", headers=auth_headers)
    first = (await _sessions(app))[0]
    assert first.status == "paused"

    fake_twitch.set_live("1002", True, started=datetime(2026, 11, 15, 9, 0, tzinfo=UTC))  # restarted stream
    await _age_checks(app)
    await client.post("/api/v1/monitoring/heartbeat", json=HB, headers=auth_headers)
    old, new = await _sessions(app)
    assert old.status == "ended" and new.status == "active"
    assert new.broadcast_started_at == datetime(2026, 11, 15, 9, 0, tzinfo=UTC)


async def test_disabling_or_removing_a_streamer_ends_its_session(client, auth_headers, app, fake_twitch) -> None:
    s = await _add(client, auth_headers)
    fake_twitch.set_live("1002", True)
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    await client.patch(f"/api/v1/streamers/{s['id']}", json={"monitoring_enabled": False}, headers=auth_headers)
    await app.state.monitoring.run_cycle()
    [sess] = await _sessions(app)
    assert sess.status == "ended"


async def test_polling_respects_interval_and_batches(client, auth_headers, app, fake_twitch) -> None:
    await _add(client, auth_headers, "alpha")
    await _add(client, auth_headers, "bravo")
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    calls = [c for c in fake_twitch.calls if c[0] == "live_status"]
    assert len(calls) == 1 and set(calls[0][1]) == {"1001", "1002"}  # one batched call

    fake_twitch.calls.clear()
    await app.state.monitoring.run_cycle()  # checked moments ago → not due yet
    assert not any(c[0] == "live_status" for c in fake_twitch.calls)
    await _age_checks(app, minutes=3)  # > 120 s interval
    await app.state.monitoring.run_cycle()
    assert any(c[0] == "live_status" for c in fake_twitch.calls)


async def test_platform_outage_keeps_state_and_does_not_crash(client, auth_headers, app, fake_twitch) -> None:
    from app.errors import PlatformUnavailableError

    await _add(client, auth_headers)
    fake_twitch.set_live("1002", True)
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    fake_twitch.fail_with = PlatformUnavailableError("Could not reach Twitch", code="platform_unreachable")
    await _age_checks(app)
    summary = await app.state.monitoring.run_cycle()
    assert summary.unavailable == {"twitch": "Could not reach Twitch"}
    [sess] = await _sessions(app)
    assert sess.status == "active"  # unknown ≠ offline: nothing is ended on an outage

    # Backoff: the failing platform is not polled again on the next ticks.
    fake_twitch.calls.clear()
    again = await app.state.monitoring.run_cycle()
    assert again.backed_off == ["twitch"]
    assert not any(c[0] == "live_status" for c in fake_twitch.calls)
    b = app.state.monitoring.backoff["twitch"]
    assert b.failures == 1

    # After the backoff window, polling resumes and success resets it.
    b.until = datetime.now(UTC) - timedelta(seconds=1)
    fake_twitch.fail_with = None
    await app.state.monitoring.run_cycle()
    assert any(c[0] == "live_status" for c in fake_twitch.calls)
    assert app.state.monitoring.backoff["twitch"].failures == 0


async def test_users_are_isolated(client, auth_headers, app, fake_twitch) -> None:
    await _add(client, auth_headers)
    other = {"Authorization": f"Bearer {(await register(client, 'other@example.com'))['access_token']}"}
    await _add(client, other)
    fake_twitch.set_live("1002", True)
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)  # only user 1 leases
    sessions = await _sessions(app)
    assert len(sessions) == 1
    assert (await client.get("/api/v1/monitoring", headers=other)).json()["total"] == 0
    assert (await client.get(f"/api/v1/monitoring/{sessions[0].id}", headers=other)).status_code == 404


async def test_retention_sweep(client, auth_headers, app, fake_twitch) -> None:
    await _add(client, auth_headers)
    fake_twitch.set_live("1002", True)
    await client.patch("/api/v1/settings", json={"privacy": {"retentionDays": 7}}, headers=auth_headers)
    await client.post("/api/v1/monitoring/start", json=HB, headers=auth_headers)
    async with app.state.sessionmaker() as db:
        await db.execute(update(StreamEvent).values(created_at=datetime.now(UTC) - timedelta(days=8)))
        db.add(OAuthState(user_id=1, platform="twitch", state_hash="x" * 64, expires_at=datetime.now(UTC) - timedelta(days=2)))
        await db.commit()
        result = await sweep(db)
        await db.commit()
        assert result.events == 1 and result.oauth_states == 1
        assert (await db.scalar(select(StreamEvent))) is None


async def test_scheduler_loop_runs_and_survives_errors() -> None:
    import asyncio

    from app.monitoring.scheduler import Scheduler

    class Engine:
        calls = 0

        async def run_cycle(self) -> None:
            Engine.calls += 1
            if Engine.calls == 1:
                raise RuntimeError("boom")

        def maker(self):  # retention sweep uses a session; make it a no-op context
            class _S:
                async def __aenter__(self_inner):
                    return self_inner

                async def __aexit__(self_inner, *a):
                    return False

                async def execute(self_inner, *a, **k):
                    class R:
                        rowcount = 0

                        def all(self):
                            return []

                    return R()

                async def scalars(self_inner, *a, **k):
                    class R:
                        def all(self):
                            return []

                    return R()

                async def commit(self_inner):
                    return None

            return _S()

    sched = Scheduler(Engine(), tick_seconds=0, retention_seconds=3600)  # type: ignore[arg-type]
    sched.start()
    for _ in range(50):
        await asyncio.sleep(0.01)
        if Engine.calls >= 3:
            break
    await sched.stop()
    assert Engine.calls >= 3  # kept running after the first cycle raised
