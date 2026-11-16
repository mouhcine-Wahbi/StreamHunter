"""Phase 7: laughter / cheering / screaming in recordings (sound classification)."""

from __future__ import annotations

import os
import shutil
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import select

from app.clipping.ffmpeg_processor import MediaProcessingError
from app.clipping.sound_classifier import YamnetClassifier
from app.detection.sound_events import (
    SOUND_KINDS,
    Frame,
    SoundEvent,
    detect_sound_events,
    sound_score,
    strongest,
    window_sounds,
)
from app.models import StreamEvent
from tests.test_media import _job, _session, _upload, ctx, recording  # noqa: F401 - shared fixtures


def frames(seconds: int = 90, **spans: tuple[int, int, float]) -> list[Frame]:
    """Per-second probabilities: kind=(first second, last second, probability)."""
    out: list[Frame] = []
    for t in range(seconds):
        probs = {k: 0.01 for k in SOUND_KINDS}
        for kind, (a, b, p) in spans.items():
            if a <= t <= b:
                probs[kind] = p
        out.append((float(t), probs))
    return out


class FakeClassifier:
    def __init__(self, result: list[Frame] | Exception, *, available: bool = True):
        self.result = result
        self._available = available
        self.calls = 0

    @property
    def available(self) -> bool:
        return self._available

    async def classify(self, ffmpeg: str, path: Path, *, timeout: float) -> list[Frame]:
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


# --- events from per-second probabilities ---------------------------------------------------------
def test_events_merge_short_gaps_and_drop_blips() -> None:
    f = frames(60, laughter=(10, 14, 0.8))
    f[16] = (16.0, {**f[16][1], "laughter": 0.5})  # back after a 1 s pause → same laugh
    f[40] = (40.0, {**f[40][1], "screaming": 0.9})  # a single second: a blip, not an event
    assert detect_sound_events(f) == [SoundEvent("laughter", 10.0, 17.0, 10.0, 0.8)]


def test_window_signals_and_scores() -> None:
    f = frames(60, cheering=(20, 23, 0.9), laughter=(30, 31, 0.35))
    assert window_sounds(f, 18, 25) == {"laughter": 0.01, "cheering": 0.9, "screaming": 0.01}
    assert window_sounds(f, 100, 120) is None  # not covered by the recording
    assert strongest(window_sounds(f, 18, 25)) == ("cheering", 0.9)
    assert strongest(window_sounds(f, 29, 33)) is None  # 35 % isn't clear enough to name the moment
    assert (sound_score(0.3), sound_score(0.6), sound_score(0.95)) == (50.0, 100.0, 100.0)


# --- post-stream analysis -------------------------------------------------------------------------
async def test_laughter_names_a_chat_moment_and_lifts_audio(ctx, recording: Path) -> None:  # noqa: F811
    app, client, h = ctx
    app.state.media_jobs.sound_classifier = FakeClassifier(frames(laughter=(8, 12, 0.8)))
    sid, [quiet] = await _session(app, candidates=[(1005, 1025, 70)])
    async with app.state.sessionmaker() as db:  # chat only knew "people reacted"
        from app.models import HighlightCandidate

        c = await db.get(HighlightCandidate, quiet)
        c.category = "audience_reaction"
        await db.commit()
    m = (await _upload(client, h, recording, session_id=sid, offset_in_stream_sec=1000)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    r = (await _job(app, client, h, job["id"]))["result"]
    assert r["sound_classification"] == "done" and r["sound_events"] == {"laughter": 1, "cheering": 0, "screaming": 0}

    [c] = [x for x in (await client.get("/api/v1/highlights?limit=100", headers=h)).json()["items"] if x["id"] == quiet]
    b = c["signal_breakdown"]
    assert c["category"] == "funny_moment" and "Laughter in the audio (80% match)" in c["reasons"]
    assert b["sounds"]["laughter"] == 0.8 and b["audio"] == 100 and b["audio_loudness"] < 20
    async with app.state.sessionmaker() as db:
        [e] = (await db.scalars(select(StreamEvent).where(StreamEvent.event_type == "laughter"))).all()
    assert e.stream_offset_sec == 1008 and e.event_metadata["end"] == 1013


async def _analyze_fresh(app, client, h, rec: Path, result: list[Frame]) -> tuple[dict, list[dict]]:  # type: ignore[no-untyped-def,type-arg]
    app.state.media_jobs.sound_classifier = FakeClassifier(result)
    sid, _ = await _session(app)
    m = (await _upload(client, h, rec, session_id=sid)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    r = (await _job(app, client, h, job["id"]))["result"]
    items = (await client.get("/api/v1/highlights", headers=h)).json()["items"]
    return r, sorted(items, key=lambda c: c["start_offset_sec"])


async def test_sound_only_candidate_gets_its_category(ctx, recording: Path) -> None:  # noqa: F811
    app, client, h = ctx
    # Cheering during the loud tone at 60–65 s: one moment (the loudness peak is the same one).
    r, [cheer] = await _analyze_fresh(app, client, h, recording, frames(cheering=(60, 64, 0.9)))
    assert r["candidates_created"] == 1
    assert cheer["category"] == "exciting_moment" and cheer["reasons"][0] == "Cheering in the audio (90% match) for 5 s"
    assert any(x.startswith("Audio ") for x in cheer["reasons"])  # it was also much louder than usual
    assert cheer["confidence"] == 0.95 and cheer["signal_breakdown"]["chat"] is None


async def test_nearby_sound_moments_are_merged(ctx, recording: Path) -> None:  # noqa: F811
    app, client, h = ctx
    # Laughter at the 30 s cut and cheering at 60 s: their padded windows overlap → one highlight.
    r, [moment] = await _analyze_fresh(app, client, h, recording, frames(laughter=(28, 32, 0.7), cheering=(60, 64, 0.9)))
    assert r["candidates_created"] == 2 and r["candidates_merged"] == 1
    assert moment["category"] == "funny_moment" and moment["origin"] == "merged"
    assert {"Laughter in the audio (70% match) for 5 s", "Cheering in the audio (90% match) for 5 s"} <= set(moment["reasons"])


async def test_classifier_failure_keeps_the_rest_of_the_analysis(ctx, recording: Path) -> None:  # noqa: F811
    app, client, h = ctx
    app.state.media_jobs.sound_classifier = FakeClassifier(MediaProcessingError("Could not download the sound model"))
    sid, _ = await _session(app)
    m = (await _upload(client, h, recording, session_id=sid)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    done = await _job(app, client, h, job["id"])
    assert done["status"] == "succeeded"
    assert done["result"]["sound_classification"] == "failed: Could not download the sound model"
    assert done["result"]["candidates_created"] == 1  # the loudness peak is still found


async def test_capability_and_switch(ctx, recording: Path) -> None:  # noqa: F811
    app, client, h = ctx
    cap = lambda: client.get("/api/v1/media/capabilities", headers=h)  # noqa: E731
    assert (await cap()).json()["sound_events"] == "requires_configuration"
    fake = FakeClassifier(frames())
    app.state.media_jobs.sound_classifier = fake
    assert (await cap()).json()["sound_events"] == "supported"
    app.state.settings.sound_events_enabled = False
    assert (await cap()).json()["sound_events"] == "requires_configuration"
    sid, _ = await _session(app)
    m = (await _upload(client, h, recording, session_id=sid)).json()
    job = (await client.post(f"/api/v1/media/{m['id']}/analyze", headers=h)).json()
    assert (await _job(app, client, h, job["id"]))["result"]["sound_classification"] == "not_installed" and fake.calls == 0


# --- the real model (only when it is already on this machine; tests never download it) ----------
MODEL_DIR = os.environ.get("SOUND_MODEL_DIR")


@pytest.mark.skipif(not MODEL_DIR or not (Path(MODEL_DIR) / "yamnet.tflite").exists(), reason="set SOUND_MODEL_DIR to a folder with yamnet.tflite")
async def test_real_model_hears_a_tone_not_laughter(recording: Path) -> None:  # noqa: F811
    c = YamnetClassifier(MODEL_DIR or "")
    if not c.available:
        pytest.skip("ai-edge-litert not installed")
    got = await c.classify(shutil.which("ffmpeg") or "ffmpeg", recording, timeout=120)
    assert 89 <= len(got) <= 91 and detect_sound_events(got) == []


@pytest.mark.skipif(not MODEL_DIR or not (Path(MODEL_DIR) / "yamnet.tflite").exists(), reason="set SOUND_MODEL_DIR to a folder with yamnet.tflite")
def test_kinds_match_the_model_labels() -> None:
    with zipfile.ZipFile(Path(MODEL_DIR or "") / "yamnet.tflite") as z:
        labels = set(z.read("yamnet_label_list.txt").decode().splitlines())
    for names in SOUND_KINDS.values():
        assert set(names) <= labels
