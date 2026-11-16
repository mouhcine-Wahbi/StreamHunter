"""Speech-to-text subtitles for exported clips.

Transcription runs locally with faster-whisper (an optional dependency): the clip's audio never
leaves the backend machine. The model is downloaded once, on first use, into the models folder.
"""

from __future__ import annotations

import asyncio
import importlib.util
import textwrap
import threading
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.clipping.ffmpeg_processor import MediaProcessingError

# Caption layout: short lines read better on vertical video.
MAX_LINE_CHARS = {"9:16": 28, "1:1": 34}
DEFAULT_LINE_CHARS = 42
MAX_LINES = 2


@dataclass(frozen=True, slots=True)
class Segment:
    start: float
    end: float
    text: str


@dataclass(frozen=True, slots=True)
class Transcript:
    language: str | None
    segments: list[Segment]


class Transcriber(Protocol):
    @property
    def available(self) -> bool: ...

    async def transcribe(self, audio: Path, *, language: str | None, timeout: float) -> Transcript: ...


class WhisperTranscriber:
    """faster-whisper on the CPU (int8). The model is loaded lazily and reused across jobs."""

    def __init__(self, model: str, model_dir: str | Path):
        self.model_name = model
        self.model_dir = Path(model_dir)
        self._model: Any = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return importlib.util.find_spec("faster_whisper") is not None

    def _load(self) -> Any:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self.model_dir.mkdir(parents=True, exist_ok=True)
                try:
                    self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8",
                                               download_root=str(self.model_dir))
                except Exception as exc:  # noqa: BLE001 - surface a readable reason on the job
                    raise MediaProcessingError(
                        f"Could not load the speech model '{self.model_name}' (the first run downloads it; "
                        f"check the internet connection): {type(exc).__name__}"
                    ) from exc
            return self._model

    @staticmethod
    def _samples(audio: Path) -> Any:
        """16 kHz mono PCM WAV → float32 samples in [-1, 1].

        Passing samples (not a path) keeps faster-whisper's own decoder (PyAV) out of the way:
        newer PyAV releases are not compatible with it, and FFmpeg has already decoded the audio.
        """
        import numpy as np

        with wave.open(str(audio), "rb") as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
                raise MediaProcessingError("Speech recognition needs 16 kHz mono 16-bit audio")
            pcm = w.readframes(w.getnframes())
        return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0

    def _run(self, audio: Path, language: str | None) -> Transcript:
        model = self._load()
        try:
            segments, info = model.transcribe(self._samples(audio), language=language, beam_size=5, vad_filter=True)
            out = [Segment(float(s.start), float(s.end), s.text.strip()) for s in segments if s.text.strip()]
        except MediaProcessingError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface a readable reason on the job
            raise MediaProcessingError(f"Speech recognition failed: {type(exc).__name__}") from exc
        return Transcript(language=getattr(info, "language", language), segments=out)

    async def transcribe(self, audio: Path, *, language: str | None, timeout: float) -> Transcript:
        if not self.available:
            raise MediaProcessingError("Speech recognition is not installed on the backend (faster-whisper)")
        try:
            # The worker thread can't be killed; on timeout the job fails and the thread finishes on its own.
            return await asyncio.wait_for(asyncio.to_thread(self._run, audio, language), timeout=timeout)
        except TimeoutError:
            raise MediaProcessingError(f"Speech recognition took longer than {int(timeout)} s and was stopped")


def _timestamp(sec: float) -> str:
    ms = max(0, round(sec * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def cues(segments: list[Segment], *, aspect: str, duration: float | None = None) -> list[Segment]:
    """Split segments into on-screen cues of at most MAX_LINES short lines.

    A long segment is divided into several cues; its time is shared in proportion to the text.
    """
    width = MAX_LINE_CHARS.get(aspect, DEFAULT_LINE_CHARS)
    out: list[Segment] = []
    for seg in segments:
        lines = textwrap.wrap(" ".join(seg.text.split()), width=width, break_long_words=True)
        if not lines:
            continue
        groups = [lines[i:i + MAX_LINES] for i in range(0, len(lines), MAX_LINES)]
        total = sum(len(" ".join(g)) for g in groups)
        t = seg.start
        span = max(0.0, seg.end - seg.start)
        for g in groups:
            text = "\n".join(g)
            end = t + span * len(" ".join(g)) / total
            out.append(Segment(t, end, text))
            t = end
    if duration is not None:
        out = [Segment(c.start, min(c.end, duration), c.text) for c in out if c.start < duration]
    return [c for c in out if c.end > c.start]


def to_srt(items: list[Segment]) -> str:
    blocks = [f"{i}\n{_timestamp(c.start)} --> {_timestamp(c.end)}\n{c.text}\n" for i, c in enumerate(items, 1)]
    return "\n".join(blocks)
