"""Audio and visual signals from an authorized recording (post-stream).

Audio "excitement" = loudness well above this recording's own rolling baseline (shouting,
cheering, sudden loud moments). It cannot tell laughter from screaming; it is one signal,
combined with chat when both exist. Visual signal = density of scene changes.
"""

from __future__ import annotations

import statistics
from bisect import bisect_left, bisect_right
from dataclasses import dataclass

BASELINE_SECONDS = 120
MIN_DELTA_DB = 6.0  # ≈2× amplitude above the usual level
MIN_DURATION = 2  # seconds above the threshold
SILENCE_DB = -60.0


@dataclass(frozen=True, slots=True)
class AudioPeak:
    start: float
    end: float
    peak_t: float
    delta_db: float
    score: float  # 0..100


def _baseline(values: list[float], i: int) -> float:
    lo = max(0, i - BASELINE_SECONDS)
    window = [v for v in values[lo:i] if v > SILENCE_DB] or [v for v in values[max(0, i - 10):i + 1]]
    return statistics.median(window) if window else SILENCE_DB


def delta_series(series: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """(t, dB above the rolling median of the previous 2 min)."""
    values = [db for _, db in series]
    return [(t, values[i] - _baseline(values, i)) for i, (t, _) in enumerate(series)]


def score_for_delta(delta_db: float) -> float:
    return round(max(0.0, min(100.0, (delta_db / 15.0) * 100)), 1)


def detect_audio_peaks(series: list[tuple[float, float]]) -> list[AudioPeak]:
    """Runs of ≥ MIN_DURATION seconds at least MIN_DELTA_DB above the rolling baseline."""
    if len(series) < 30:
        return []  # too short to know what "normal" sounds like
    deltas = delta_series(series)
    peaks: list[AudioPeak] = []
    run: list[tuple[float, float]] = []
    for t, d in deltas + [(float("inf"), -999.0)]:
        if d >= MIN_DELTA_DB and t != float("inf"):
            run.append((t, d))
            continue
        if len(run) >= MIN_DURATION:
            pt, pd = max(run, key=lambda x: x[1])
            peaks.append(AudioPeak(start=run[0][0], end=run[-1][0] + 1, peak_t=pt, delta_db=round(pd, 1), score=score_for_delta(pd)))
        run = []
    return peaks


def window_audio_score(deltas: list[tuple[float, float]], start: float, end: float) -> float | None:
    """Audio signal for a time window: how far above normal the loudest second was (0–100)."""
    times = [t for t, _ in deltas]
    lo, hi = bisect_left(times, start), bisect_right(times, end)
    if lo >= hi:
        return None  # window not covered by the recording
    return score_for_delta(max(d for _, d in deltas[lo:hi]))


def window_visual_score(cuts: list[float], start: float, end: float, duration: float) -> float | None:
    """Scene-change density in the window relative to the whole recording (0–100)."""
    # Only the part of the window the recording actually covers; none → not measured.
    start, end = max(0.0, start), min(duration, end)
    if duration <= 0 or end <= start:
        return None
    lo, hi = bisect_left(cuts, start), bisect_right(cuts, end)
    in_window = (hi - lo) / (end - start)
    usual = len(cuts) / duration
    if usual == 0:
        return 0.0 if in_window == 0 else 60.0
    return round(max(0.0, min(100.0, (in_window / usual) * 25)), 1)  # 4× the usual cut rate → 100
