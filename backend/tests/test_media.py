"""Phase 7: authorized media, post-stream analysis, export (real FFmpeg), VOD discovery."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.config import Settings
from app.db.base import Base
from app.domain.enums import Platform
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.main import create_app
from app.models import HighlightCandidate, MediaJob, MonitoringSession, Streamer, User
from tests.fakes import FakePlatform
from tests.platform_mocks import FakeTwitch, transport

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg not installed")


@pytest.fixture(scope="module")
def recording(tmp_path_factory) -> Path:  # type: ignore[no-untyped-def]
    """90 s: blue → white → black (cuts at 30 s, 60 s); a tone that is loud only at 60–65 s."""
    out = tmp_path_factory.mktemp("rec") / "stream.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=30", "-f", "lavfi", "-i", "color=c=white:s=640x360:r=25:d=30",
         "-f", "lavfi", "-i", "color=c=black:s=640x360:r=25:d=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
         "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume='if(between(t,60,65),1.0,0.05)':eval=frame[a]",
         "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(out)],
        check=True,
    )
    return out


@pytest.fixture
async def ctx(tmp_path) -> AsyncIterator[tuple]:  # type: ignore[type-arg]
    settings = Settings(_env_file=None, app_env="test", scheduler_enabled=False, media_root=str(tmp_path / "media"),
                        database_url=f"sqlite+aiosqlite:///{tmp_path / 'm.db'}", max_upload_mb=10)
    app = create_app(settings, registry=PlatformRegistry({Platform.TWITCH: FakePlatform(Platform.TWITCH), Platform.KICK: FakePlatform(Platform.KICK)}))
    app.state.media_jobs.sound_classifier = None  # tests never download the sound model (see test_sound_events.py)
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v1/auth/register", json={"email": "ed@example.com", "username": "ed", "password": "long password"})
        yield app, client, {"Authorization": f"Bearer {r.json()['access_token']}"}
    await app.state.media_jobs.stop()
    await app.state.engine.dispose()


async def _session(app, *, platform: str = "kick", candidates: list[tuple[float, float, float]] = ()) -> tuple[int, list[int]]:  # type: ignore[no-untyped-def,assignment]
    async with app.state.sessionmaker() as db:
        user = await db.scalar(select(User))
        s = Streamer(platform=platform, platform_user_id=f"p{datetime.now().timestamp()}", username="kickstar", display_name="KickStar", is_live=False)
        db.add(s)
        await db.flush()
        start = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
        sess = MonitoringSession(user_id=user.id, streamer_id=s.id, platform=platform, status="ended", started_at=start, broadcast_started_at=start)
        db.add(sess)
        await db.flush()
        ids = []
        for a, b, score in candidates:
            c = HighlightCandidate(user_id=user.id, session_id=sess.id, streamer_id=s.id, platform=platform,
                                   timestamp=start + timedelta(seconds=a), start_offset_sec=a, end_offset_sec=b, score=score,
                                   confidence=0.8, category="funny_moment", reasons=["'KEKW' used by 30 chatters"],
                                   signal_breakdown={"chat": score, "audio": None, "visual": None, "context": None}, status="pending_review")
            db.add(c)
            await db.flush()
            ids.append(c.id)
        await db.commit()
        return sess.id, ids


async def _upload(client, h, recording: Path, **form) -> httpx.Response:  # type: ignore[no-untyped-def]
    data = {"rights_confirmed": "true", **{k: str(v) for k, v in form.items()}}
    return await client.post("/api/v1/media/upload", headers=h, data=data,
                             files={"file": ("../../My Stream!.mp4", recording.read_bytes(), "video/mp4")})


async def _job(app, client, h, job_id: int) -> dict:  # type: ignore[no-untyped-def]
    await app.state.media_jobs.drain()
    return (await client.get(f"/api/v1/media/jobs/{job_id}", headers=h)).json()


async def test_capabilities(ctx) -> None:
    _, client, h = ctx
    c = (await client.get("/api/v1/media/capabilities", headers=h)).json()
    assert c["ffmpeg_available"] is True and c["export"] == "supported"
    assert c["platform_vod_download"] == "unsupported" and c["live_tab_audio"] == "supported"
    assert c["media_folder"].endswith("/library/1")


async def test_upload_and_register_rules(ctx, recording: Path) -> None:
    app, client, h = ctx
    no_rights = await client.post("/api/v1/media/upload", headers=h, data={"rights_confirmed": "false"},
                                  files={"file": ("a.mp4", b"x", "video/mp4")})
    assert no_rights.status_code == 400 and no_rights.json()["error"]["code"] == "rights_not_confirmed"
    bad_type = await client.post("/api/v1/media/upload", headers=h, data={"rights_confirmed": "true"},
                                 files={"file": ("a.exe", b"MZ", "application/octet-stream")})
    assert bad_type.json()["error"]["code"] == "invalid_media_type"
    garbage = await client.post("/api/v1/media/upload", headers=h, data={"rights_confirmed": "true"},
                                files={"file": ("broken.mp4", b"not a video", "video/mp4")})
    assert garbage.status_code == 400 and garbage.json()["error"]["code"] == "invalid_media"
    assert "/" not in garbage.json()["error"]["message"]  # no server paths leaked
    assert list((Path(app.state.settings.media_root) / "library" / "1").iterdir()) == []  # failed uploads are cleaned up

    r = await _upload(client, h, recording)
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["original_name"] == "My_Stream.mp4"  # directory parts and odd characters stripped
    assert m["has_audio"] and m["has_video"] and round(m["duration_sec"]) == 90 and (m["width"], m["height"]) == (640, 360)

    lib = Path(app.state.settings.media_root) / "library" / "1"
    shutil.copy(recording, lib / "big_vod.mp4")
    for bad in ("../../m.db", "/etc/passwd", "big_vod.exe", "missing.mp4"):
        resp = await client.post("/api/v1/media/register", headers=h, json={"relative_path": bad, "rights_confirmed": True})
        assert resp.status_code in (400, 422), bad
    ok = await client.post("/api/v1/media/register", headers=h, json={"relative_path": "big_vod.mp4", "rights_confirmed": True})
    assert ok.status_code == 201 and ok.json()["kind"] == "registered"
    assert (await client.post("/api/v1/media/register", headers=h, json={"relative_path": "big_vod.mp4"})).status_code == 422

    app.state.settings.max_upload_mb = 1
    too_big = await client.post("/api/v1/media/upload", headers=h, data={"rights_confirmed": "true"},
                                files={"file": ("huge.mp4", b"\0" * (2 * 1024 * 1024), "video/mp4")})
    assert too_big.status_code == 400 and too_big.json()["error"]["code"] == "file_too_large"
    assert not any(p.name.endswith("huge.mp4") for p in lib.iterdir())  # partial file removed


async def test_post_stream_analysis_enriches_creates_and_merges(ctx, recording: Path) -> None:
    app, client, h = ctx
    # The recording starts 1000 s into the stream, so the loud burst is at stream 1060–1065 s.
    sid, (loud, quiet, overlap_a, overlap_b) = await _session(app, candidates=[
        (1050, 1075, 70), (1005, 1025, 70), (1200, 1230, 50), (1220, 1250, 65)])
    m = (await _upload(client, h, recording, session_id=sid, offset_in_stream_sec=1000)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    assert job["status"] == "queued"
    done = await _job(app, client, h, job["id"])
    assert done["status"] == "succeeded", done
    r = done["result"]
    assert r["audio_peaks"] == 1 and r["scene_changes"] == 2 and r["candidates_enriched"] == 2 and r["candidates_merged"] == 1

    items = {c["id"]: c for c in (await client.get("/api/v1/highlights?limit=100", headers=h)).json()["items"]}
    L, Q = items[loud], items[quiet]
    assert L["signal_breakdown"]["audio"] == 100 and L["score"] > 70 and any(x.startswith("Audio ") for x in L["reasons"])
    assert Q["signal_breakdown"]["audio"] < 20 and Q["score"] < 70  # chat-only moment, quiet audio: lower combined score
    assert Q["signal_breakdown"]["chat_only_score"] == 70
    assert overlap_b not in items and items[overlap_a]["origin"] == "merged"
    assert (items[overlap_a]["start_offset_sec"], items[overlap_a]["end_offset_sec"]) == (1200, 1250)


async def test_audio_only_candidate(ctx, recording: Path) -> None:
    app, client, h = ctx
    sid, _ = await _session(app)
    m = (await _upload(client, h, recording, session_id=sid)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    assert (await _job(app, client, h, job["id"]))["result"]["candidates_created"] == 1
    [c] = (await client.get("/api/v1/highlights", headers=h)).json()["items"]
    assert c["origin"] == "vod" and c["category"] == "unknown" and c["signal_breakdown"]["chat"] is None
    assert c["start_offset_sec"] == 40 and c["end_offset_sec"] == 76  # peak 60–66 s with 20 s / 10 s padding
    assert c["reasons"][0].startswith("Audio 26")


async def test_analyze_requires_attached_session(ctx, recording: Path) -> None:
    _, client, h = ctx
    m = (await _upload(client, h, recording)).json()
    assert (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()["error"]["code"] == "media_not_attached"


async def test_export_vertical_mp4_and_download(ctx, recording: Path) -> None:
    app, client, h = ctx
    sid, (cid, far) = await _session(app, candidates=[(55, 70, 80), (500, 520, 80)])
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    no_media = await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    assert no_media.json()["error"]["code"] == "media_unavailable"

    await _upload(client, h, recording, session_id=sid)
    r = await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    assert r.status_code == 202 and r.json()["status"] == "exporting"
    await app.state.media_jobs.drain()
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["status"] == "ready" and c["local_file_path"] == f"clip_{clip['id']}_9x16.mp4"
    dl = await client.get(f"/api/v1/clips/{clip['id']}/file", headers=h)
    assert dl.status_code == 200 and dl.headers["content-type"] == "video/mp4" and len(dl.content) > 1000
    out = Path(app.state.settings.media_root) / "exports" / "1" / c["local_file_path"]
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(out)],
                                     capture_output=True, check=True).stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"], v["codec_name"]) == (1080, 1920, "h264")
    assert any(s["codec_type"] == "audio" for s in info["streams"])
    assert 14 <= float(info["format"]["duration"]) <= 16

    # Ready clips can be published (with confirmation).
    assert (await client.post(f"/api/v1/clips/{clip['id']}/publish", json={"confirm": True}, headers=h)).json()["status"] == "published"

    # A moment the recording doesn't cover is refused up front.
    far_clip = (await client.post(f"/api/v1/highlights/{far}/approve", headers=h)).json()["clip"]
    assert (await client.post(f"/api/v1/clips/{far_clip['id']}/export", headers=h)).json()["error"]["code"] == "outside_recording"


async def test_failed_export_restores_clip_state(ctx, recording: Path) -> None:
    app, client, h = ctx
    sid, (cid,) = await _session(app, candidates=[(55, 70, 80)])
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    m = (await _upload(client, h, recording, session_id=sid)).json()
    (Path(app.state.settings.media_root) / "library" / "1").joinpath(
        next(p.name for p in (Path(app.state.settings.media_root) / "library" / "1").iterdir())).unlink()  # file vanished
    await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    await app.state.media_jobs.drain()
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["status"] == "unsupported" and c["error_message"].startswith("Export failed")
    async with app.state.sessionmaker() as db:
        job = await db.scalar(select(MediaJob))
        assert job.status == "failed" and job.media_source_id == m["id"]


async def test_media_ownership(ctx, recording: Path) -> None:
    app, client, h = ctx
    sid, _ = await _session(app)
    m = (await _upload(client, h, recording, session_id=sid)).json()
    other = await client.post("/api/v1/auth/register", json={"email": "o@example.com", "username": "oo", "password": "long password"})
    oh = {"Authorization": f"Bearer {other.json()['access_token']}"}
    assert (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=oh)).status_code == 404
    assert (await client.patch(f"/api/v1/media/{m['id']}", json={"offset_in_stream_sec": 5}, headers=oh)).status_code == 404
    assert (await client.delete(f"/api/v1/media/{m['id']}", headers=oh)).status_code == 404
    assert (await client.get("/api/v1/media", headers=oh)).json()["total"] == 0
    # Can't attach to someone else's session either.
    up = await _upload(client, oh, recording, session_id=sid)
    assert up.status_code == 404


async def test_twitch_vod_discovery_and_links(tmp_path) -> None:
    tw = FakeTwitch()
    start = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
    tw.videos = [{"id": "v999", "user_id": "101", "url": "https://www.twitch.tv/videos/v999", "created_at": "2026-11-15T10:00:30Z", "type": "archive"},
                 {"id": "old", "user_id": "101", "url": "https://www.twitch.tv/videos/old", "created_at": "2026-11-14T10:00:00Z", "type": "archive"}]
    settings = Settings(_env_file=None, app_env="test", scheduler_enabled=False, database_url=f"sqlite+aiosqlite:///{tmp_path / 'v.db'}",
                        twitch_client_id="tw-client", twitch_client_secret=SecretStr("tw-secret"), media_root=str(tmp_path / "media"))
    app = create_app(settings, registry=PlatformRegistry({Platform.TWITCH: TwitchAdapter(settings, transport=transport(tw.handler)),
                                                          Platform.KICK: FakePlatform(Platform.KICK)}))
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        h = {"Authorization": f"Bearer {(await client.post('/api/v1/auth/register', json={'email': 'a@example.com', 'username': 'aa', 'password': 'long password'})).json()['access_token']}"}
        async with app.state.sessionmaker() as db:
            s = Streamer(platform="twitch", platform_user_id="101", username="streamerone", display_name="StreamerOne")
            db.add(s)
            await db.flush()
            sess = MonitoringSession(user_id=1, streamer_id=s.id, platform="twitch", status="ended", started_at=start, broadcast_started_at=start)
            db.add(sess)
            await db.flush()
            db.add(HighlightCandidate(user_id=1, session_id=sess.id, streamer_id=s.id, platform="twitch", timestamp=start,
                                      start_offset_sec=3725.4, end_offset_sec=3760, score=80, confidence=0.9, category="other",
                                      reasons=[], status="pending_review"))
            await db.commit()
            sess_id = sess.id
        out = (await client.post(f"/api/v1/monitoring/{sess_id}/vod", headers=h)).json()
        assert out["vod_id"] == "v999" and out["vod_url"] == "https://www.twitch.tv/videos/v999"
        [hl] = (await client.get("/api/v1/highlights", headers=h)).json()["items"]
        assert hl["vod_url_at"] == "https://www.twitch.tv/videos/v999?t=1h2m5s"
    await app.state.engine.dispose()
