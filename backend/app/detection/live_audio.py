"""Live stream loudness measured in an editor's browser tab (Phase 7, live tab audio).

The extension sends one loudness value (RMS, dBFS) per second while the editor has a
channel open. Only these numbers arrive; audio itself never leaves the browser. Per
streamer, the last few minutes are kept in memory and used like the post-stream audio
signal: how far above this stream's own rolling baseline a highlight's window was.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.detection.audio_detector import BASELINE_SECONDS, delta_series, window_audio_score

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
        self.last_received: datetime | None = None

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

    def prune(self, now: datetime) -> None:
        cutoff = int((now - KEEP).timestamp())
        for k in [k for k in self._samples if k < cutoff]:
            del self._samples[k]

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
            return {"audio_state": "off"}
        series = self._series()
        latest = series[-1][1] if series else None
        delta = delta_series(series)[-1][1] if len(series) >= MIN_HISTORY else None
        return {
            "audio_state": "receiving" if now - self.last_received <= STALE_AFTER else "stale",
            "audio_level_db": latest,
            "audio_delta_db": round(delta, 1) if delta is not None else None,
            "audio_seconds": len(series),
            "audio_warming_up": len(series) < MIN_HISTORY,
        }
