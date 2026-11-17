"""Live stream loudness measured in an editor's browser tab (Phase 7, live tab audio).

The extension sends one loudness value (RMS, dBFS) per second while the editor has a
channel open. Only these numbers arrive; audio itself never leaves the browser. Per
streamer, the last few minutes are kept in memory and used like the post-stream audio
signal: how far above this stream's own rolling baseline a highlight's window was.

If the editor also turns on sound detection, the extension sends the tab's audio itself (16 kHz
mono, a few seconds at a time) to this backend, which classifies it (laughter, cheering,
screaming) and keeps only the resulting numbers per second; the audio is never stored.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.detection.audio_detector import BASELINE_SECONDS, delta_series, window_audio_score
from app.detection.sound_events import SOUND_KINDS

KEEP = timedelta(seconds=BASELINE_SECONDS + 300)  # baseline + the longest highlight window
STALE_AFTER = timedelta(seconds=20)  # batches arrive every ~5 s
MIN_HISTORY = 30  # seconds of audio before a window can be judged (same as post-stream)
MAX_FUTURE = timedelta(seconds=5)
LEAD = timedelta(seconds=15)  # the audio reaction comes a few seconds before chat reacts
FLOOR_DB = -90.0


class LiveAudioBuffer:
    """One-per-second loudness samples for one streamer, newest last."""

    def __init__(self) -> None:
        self._samples: dict[int, float] = {}  # unix second → dBFS
        self._sounds: dict[int, dict[str, float]] = {}  # unix second → {kind: value 0–1}
        self.last_received: datetime | None = None
        self.last_sounds: datetime | None = None
        self.sound_state = "off"  # off | receiving | not_installed | failed: …

    def __len__(self) -> int:
        return len(self._samples)

    def add(self, samples: list[tuple[datetime, float]], now: datetime) -> int:
        """Store samples (already on the server clock). Returns how many were accepted."""
        oldest, newest = now - KEEP, now + MAX_FUTURE
        accepted = 0
        for t, db in samples:
            if not oldest <= t <= newest:
                continue
            self._samples[int(t.timestamp())] = max(FLOOR_DB, min(0.0, db))
            accepted += 1
        if accepted:
            self.last_received = now
        self.prune(now)
        return accepted

    def add_sounds(self, values: list[tuple[datetime, dict[str, float]]], now: datetime) -> int:
        """Classifier output (server clock), one entry per half-second window; a second keeps the max."""
        oldest, newest = now - KEEP, now + MAX_FUTURE
        accepted = 0
        for t, kinds in values:
            if not oldest <= t <= newest:
                continue
            slot = self._sounds.setdefault(int(t.timestamp()), dict.fromkeys(SOUND_KINDS, 0.0))
            for k in SOUND_KINDS:
                slot[k] = max(slot[k], max(0.0, min(1.0, kinds.get(k, 0.0))))
            accepted += 1
        if accepted:
            self.last_sounds = now
            self.sound_state = "receiving"
        self.prune(now)
        return accepted

    def window_sounds(self, start: datetime, end: datetime) -> dict[str, float] | None:
        """Highest value per kind in [start − LEAD, end], or None when no sound was classified there."""
        lo, hi = int((start - LEAD).timestamp()), int(end.timestamp())
        seconds = [v for k, v in self._sounds.items() if lo <= k <= hi]
        if not seconds:
            return None
        return {kind: round(max(s[kind] for s in seconds), 3) for kind in SOUND_KINDS}

    def prune(self, now: datetime) -> None:
        cutoff = int((now - KEEP).timestamp())
        for k in [k for k in self._samples if k < cutoff]:
            del self._samples[k]
        for k in [k for k in self._sounds if k < cutoff]:
            del self._sounds[k]

    def _series(self) -> list[tuple[float, float]]:
        return [(float(k), self._samples[k]) for k in sorted(self._samples)]

    def window_score(self, start: datetime, end: datetime) -> tuple[float, float] | None:
        """(score 0–100, loudest dB above the baseline) for [start − LEAD, end], or None.

        None when there isn't enough audio before the window to know what "normal" is,
        or when the window itself wasn't measured.
        """
        series = self._series()
        lo, hi = (start - LEAD).timestamp(), end.timestamp()
        if sum(1 for t, _ in series if t < lo) < MIN_HISTORY:
            return None
        deltas = delta_series(series)
        score = window_audio_score(deltas, lo, hi)
        if score is None:
            return None
        loudest = max(d for t, d in deltas if lo <= t <= hi)
        return score, round(loudest, 1)

    def status(self, now: datetime) -> dict[str, object]:
        if self.last_received is None:
            return {"audio_state": "off", "sound_state": self.sound_state}
        series = self._series()
        latest = series[-1][1] if series else None
        delta = delta_series(series)[-1][1] if len(series) >= MIN_HISTORY else None
        return {
            "audio_state": "receiving" if now - self.last_received <= STALE_AFTER else "stale",
            "audio_level_db": latest,
            "audio_delta_db": round(delta, 1) if delta is not None else None,
            "audio_seconds": len(series),
            "audio_warming_up": len(series) < MIN_HISTORY,
            "sound_state": self.sound_state,
            "sounds_heard": self.window_sounds(now - timedelta(seconds=10) + LEAD, now) if self.last_sounds else None,
        }
