"""Phase 7 subtitles: caption layout, SRT output and subtitled export (real FFmpeg, fake speech model)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.clipping.subtitles import Segment, Transcript, cues, to_srt
from tests.test_media import _session, _upload, ctx, recording  # noqa: F401 - shared fixtures

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg not installed")


class FakeTranscriber:
    """Stands in for faster-whisper: returns fixed segments and records what it was given."""

    def __init__(self, segments: list[Segment], *, available: bool = True, language: str = "en"):
        self.segments = segments
        self._available = available
        self.language = language
        self.calls: list[dict] = []  # type: ignore[type-arg]

    @property
    def available(self) -> bool:
        return self._available

    async def transcribe(self, audio: Path, *, language: str | None, timeout: float) -> Transcript:
        info = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels:format=duration",
                               "-of", "default=nw=1", str(audio)], capture_output=True, text=True, check=True).stdout
        self.calls.append({"language": language, "probe": info})
        return Transcript(language=language or self.language, segments=self.segments)


# --- caption layout -------------------------------------------------------------------------
def test_srt_timestamps_and_numbering() -> None:
    srt = to_srt([Segment(0, 1.5, "Hello"), Segment(61.25, 3725.0, "Later")])
    assert srt == "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:01:01,250 --> 01:02:05,000\nLater\n"


def test_long_segments_are_wrapped_and_split_in_proportion() -> None:
    text = "no way he actually hit that shot from across the map chat did you see it"
    out = cues([Segment(10.0, 16.0, text)], aspect="9:16")
    assert all(len(line) <= 28 for c in out for line in c.text.split("\n"))
    assert all(len(c.text.split("\n")) <= 2 for c in out)
    assert " ".join(" ".join(c.text.split("\n")) for c in out) == text  # nothing lost
    assert out[0].start == 10.0 and abs(out[-1].end - 16.0) < 1e-9
    assert all(a.end == b.start for a, b in zip(out, out[1:], strict=False))  # contiguous
    assert len(cues([Segment(0, 2, text)], aspect="16:9")) < len(out)  # wider lines on landscape


def test_cues_are_clamped_to_the_clip() -> None:
    out = cues([Segment(1, 3, "inside"), Segment(14, 20, "runs past the end"), Segment(25, 26, "after"), Segment(5, 6, "  ")],
               aspect="16:9", duration=15)
    assert [(c.text, c.start, c.end) for c in out] == [("inside", 1, 3), ("runs past the end", 14, 15)]


# --- export with subtitles ------------------------------------------------------------------
def _frame(path: Path, at: float) -> bytes:
    return subprocess.run(["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                           "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout


@needs_ffmpeg
async def test_export_with_subtitles_burns_in_and_keeps_srt(ctx, recording: Path) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app, client, h = ctx
    fake = FakeTranscriber([Segment(0.5, 14.0, "That was the craziest clutch I have seen all week")])
    app.state.media_jobs.transcriber = fake
    sid, (cid,) = await _session(app, candidates=[(55, 70, 80)])
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    await _upload(client, h, recording, session_id=sid)
    exports = Path(app.state.settings.media_root) / "exports" / "1"

    # Plain export first, as a reference picture.
    await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    await app.state.media_jobs.drain()
    plain = _frame(exports / f"clip_{clip['id']}_9x16.mp4", 7)

    r = await client.post(f"/api/v1/clips/{clip['id']}/export", json={"subtitles": True, "language": "en"}, headers=h)
    assert r.status_code == 202
    await app.state.media_jobs.drain()
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["status"] == "ready" and c["subtitles_file_path"] == f"clip_{clip['id']}_9x16.srt"

    # The transcriber got the clip window's audio as 16 kHz mono, and the requested language.
    [call] = fake.calls
    assert call["language"] == "en" and "sample_rate=16000" in call["probe"] and "channels=1" in call["probe"]
    assert 14 <= float(call["probe"].split("duration=")[1]) <= 16
    assert not list(exports.glob("*.wav"))  # temporary audio is cleaned up

    srt = (await client.get(f"/api/v1/clips/{clip['id']}/subtitles", headers=h))
    assert srt.status_code == 200 and srt.headers["content-type"].startswith("application/x-subrip")
    assert srt.text.startswith("1\n00:00:00,500 --> ") and "craziest" in srt.text

    # Captions are actually in the picture.
    assert _frame(exports / c["local_file_path"], 7) != plain

    async with app.state.sessionmaker() as db:
        from sqlalchemy import select

        from app.models import MediaJob

        job = (await db.scalars(select(MediaJob).order_by(MediaJob.id.desc()))).first()
        assert job.result["subtitles"] == {"file": c["subtitles_file_path"], "language": "en", "cues": 1, "burned_in": True}

    # Exporting again without subtitles removes the old captions.
    await client.post(f"/api/v1/clips/{clip['id']}/export", headers=h)
    await app.state.media_jobs.drain()
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["subtitles_file_path"] is None and not list(exports.glob("*.srt"))
    assert (await client.get(f"/api/v1/clips/{clip['id']}/subtitles", headers=h)).status_code == 404


@needs_ffmpeg
async def test_no_speech_exports_without_captions(ctx, recording: Path) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app, client, h = ctx
    app.state.media_jobs.transcriber = FakeTranscriber([])
    sid, (cid,) = await _session(app, candidates=[(55, 70, 80)])
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    await _upload(client, h, recording, session_id=sid)
    await client.post(f"/api/v1/clips/{clip['id']}/export", json={"subtitles": True}, headers=h)
    await app.state.media_jobs.drain()
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["status"] == "ready" and c["local_file_path"] and c["subtitles_file_path"] is None


@needs_ffmpeg
async def test_subtitles_unavailable_and_validation(ctx, recording: Path) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    app, client, h = ctx
    app.state.media_jobs.transcriber = FakeTranscriber([], available=False)
    assert (await client.get("/api/v1/media/capabilities", headers=h)).json()["subtitles"] == "requires_configuration"
    sid, (cid,) = await _session(app, candidates=[(55, 70, 80)])
    clip = (await client.post(f"/api/v1/highlights/{cid}/approve", headers=h)).json()["clip"]
    await _upload(client, h, recording, session_id=sid)

    r = await client.post(f"/api/v1/clips/{clip['id']}/export", json={"subtitles": True}, headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "subtitles_unavailable"
    c = (await client.get(f"/api/v1/clips/{clip['id']}", headers=h)).json()
    assert c["status"] != "exporting"  # refused before anything changed

    bad = await client.post(f"/api/v1/clips/{clip['id']}/export", json={"subtitles": True, "language": "English"}, headers=h)
    assert bad.status_code == 422

    app.state.media_jobs.transcriber = FakeTranscriber([])
    assert (await client.get("/api/v1/media/capabilities", headers=h)).json()["subtitles"] == "supported"
