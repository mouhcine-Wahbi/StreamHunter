"""Phase 7: on-screen events in recordings (fast action, sudden flashes)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from sqlalchemy import select

from app.detection.visual_events import (
    VisualEvent,
    baseline,
    detect_visual_events,
    motion_per_second,
    window_motion_score,
)
from app.models import HighlightCandidate, StreamEvent
from tests.test_media import _job, _session, _upload, ctx  # noqa: F401 - shared fixtures


def pictures(seconds: int = 60, motion: float = 3.0, bright: float = 100.0, **spans: tuple[float, float, float]):  # type: ignore[no-untyped-def]
    """Four frames a second; spans: action=(from, to, motion), flash=(from, to, brightness)."""
    out = []
    for k in range(seconds * 4):
        t = k / 4
        y, m = bright, motion
        if "action" in spans and spans["action"][0] <= t < spans["action"][1]:
            m = spans["action"][2]
        if "flash" in spans and spans["flash"][0] <= t < spans["flash"][1]:
            y = spans["flash"][2]
        out.append((t, y, m))
    return out


# --- pure logic --------------------------------------------------------------------------------
def test_fast_action_against_the_usual_motion() -> None:
    f = pictures(action=(20, 25, 12.0))
    assert detect_visual_events(f) == [VisualEvent("fast_action", 20.0, 25.0, 20.0, 4.0)]
    m = motion_per_second(f)
    assert baseline(m) == 3.0
    assert window_motion_score(m, 3.0, 18, 26) == 100.0 and window_motion_score(m, 3.0, 30, 35) == 0.0
    assert window_motion_score(m, 3.0, 100, 110) is None
    # The same movement in a recording that always moves this much is nothing special.
    assert detect_visual_events(pictures(motion=10.0, action=(20, 25, 12.0))) == []


def test_a_cut_or_a_blip_is_not_action() -> None:
    f = pictures()
    f[80] = (20.0, 100.0, 190.0)  # one hard cut: one frame changes completely
    assert detect_visual_events(f) == [] and motion_per_second(f)[20][1] == 3.0
    assert detect_visual_events(pictures(action=(20, 21, 20.0))) == []  # one second only


def test_flash_comes_back_but_a_bright_scene_does_not() -> None:
    [e] = detect_visual_events(pictures(flash=(40, 40.5, 220.0)))
    assert (e.kind, e.start, e.strength, e.reason()) == ("screen_flash", 40.0, 120.0, "Sudden flash on screen")
    assert detect_visual_events(pictures(flash=(40, 60, 220.0))) == []  # cut to a bright scene and stays
    assert len(detect_visual_events(pictures(flash=(40, 40.25, 220.0)) )) == 1


# --- real FFmpeg, full analysis ----------------------------------------------------------------
@pytest.fixture(scope="module")
def gameplay(tmp_path_factory) -> Path:  # type: ignore[no-untyped-def]
    """60 s of grey: a burst of fast movement at 20–25 s (quiet), a white flash at 40 s (loud)."""
    out = tmp_path_factory.mktemp("game") / "game.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=60", "-f", "lavfi", "-i", "sine=frequency=300:duration=60",
         "-filter_complex",
         "[0:v]noise=alls=100:allf=t:enable='between(t,20,25)',drawbox=c=white:t=fill:enable='between(t,40,40.3)'[v];"
         "[1:a]volume='if(between(t,39,44),1.0,0.05)':eval=frame[a]",
         "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "35", "-c:a", "aac", str(out)],
        check=True,
    )
    return out


async def test_recording_analysis_finds_on_screen_moments(ctx, gameplay: Path) -> None:  # noqa: F811
    app, client, h = ctx
    sid, [chat_moment] = await _session(app, candidates=[(18, 27, 70)])  # chat flagged the fight, without a name
    async with app.state.sessionmaker() as db:
        c = await db.get(HighlightCandidate, chat_moment)
        c.category = "unknown"
        await db.commit()
    up = await _upload(client, h, gameplay, session_id=sid)
    assert up.status_code == 201, up.text
    m = up.json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    r = (await _job(app, client, h, job["id"]))["result"]
    assert r["visual_events"] == {"fast_action": 1, "screen_flash": 1}

    items = sorted((await client.get("/api/v1/highlights", headers=h)).json()["items"], key=lambda x: x["start_offset_sec"])
    # The flash came with a loud sound: a moment of its own (the fight's sound was quiet, so the fight alone
    # adds nothing). Their padded windows overlap, so it is merged into the chat moment.
    assert r["candidates_created"] == 1 and r["candidates_merged"] == 1
    [moment] = items
    assert moment["id"] == chat_moment and moment["category"] == "gameplay_highlight"
    assert any(x.startswith("Fast on-screen action (") for x in moment["reasons"])
    assert "Sudden flash on screen" in moment["reasons"] and moment["signal_breakdown"]["visual"] == 100
    async with app.state.sessionmaker() as db:
        kinds = sorted(e.event_type for e in (await db.scalars(select(StreamEvent))).all())
    assert kinds == ["audio_peak", "fast_action", "screen_flash"]
