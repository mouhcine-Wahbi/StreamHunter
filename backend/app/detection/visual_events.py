"""What happens *on screen*, second by second: bursts of fast action and sudden flashes (Phase 7).

FFmpeg measures, four times a second, the picture's brightness and how much of it changed since
the previous frame (app/clipping/ffmpeg_processor.picture_series). This module turns those
numbers into events and a window signal. It is generic: it doesn't know the game, so it can't
tell a kill from a menu animation. It finds "much more movement than this recording usually has"
and "the screen flashed bright and came back" (explosions, flashbangs, hit effects, camera flashes).

Pure logic, so it can be tested without FFmpeg.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from statistics import median

PictureFrame = tuple[float, float, float]  # (time, brightness 0–255, motion 0–255)
Motion = tuple[float, float]  # (second, typical motion in that second)

MIN_BASELINE = 1.5  # a near-static recording still needs this much change to count as "action"
ACTION_RATIO = 2.5  # this many times the usual motion …
ACTION_MIN = 8.0  # … and at least this much (0–255) is "fast action"
MERGE_GAP = 1.0
MIN_ACTION_SECONDS = 2.0
FULL_SCORE_RATIO = 3.0  # 3× the usual motion → visual score 100
FLASH_JUMP = 50.0  # brightness rise over the previous second that counts as a flash …
FLASH_BACK = 1.5  # … if it falls back within this many seconds
FLASH_SETTLE = 20.0  # "back" = within this much of the level before


@dataclass(frozen=True, slots=True)
class VisualEvent:
    kind: str  # "fast_action" | "screen_flash"
    start: float
    end: float
    peak_t: float
    strength: float  # motion ratio over the usual level, or the brightness jump

    def reason(self) -> str:
        if self.kind == "screen_flash":
            return "Sudden flash on screen"
        return f"Fast on-screen action ({self.strength}× the usual motion) for {int(self.end - self.start)} s"


def motion_per_second(frames: list[PictureFrame]) -> list[Motion]:
    """The median motion of each second's frames: a single hard cut doesn't look like action."""
    by_sec: dict[int, list[float]] = {}
    for t, _, ydif in frames[1:]:  # the first frame has nothing to compare with
        by_sec.setdefault(int(t), []).append(ydif)
    return [(float(s), median(v)) for s, v in sorted(by_sec.items())]


def baseline(motion: list[Motion]) -> float:
    return max(MIN_BASELINE, median(m for _, m in motion)) if motion else MIN_BASELINE


def detect_visual_events(frames: list[PictureFrame]) -> list[VisualEvent]:
    motion = motion_per_second(frames)
    usual = baseline(motion)
    events: list[VisualEvent] = []

    level = max(ACTION_MIN, usual * ACTION_RATIO)
    runs: list[list[Motion]] = []
    for t, m in motion:
        if m < level:
            continue
        if runs and t - runs[-1][-1][0] <= MERGE_GAP + 1:
            runs[-1].append((t, m))
        else:
            runs.append([(t, m)])
    for run in runs:
        start, end = run[0][0], run[-1][0] + 1
        if end - start >= MIN_ACTION_SECONDS:
            pt, pm = max(run, key=lambda x: x[1])
            events.append(VisualEvent("fast_action", start, end, pt, round(pm / usual, 1)))

    # Flashes: brightness jumps well above the previous second, then comes back down.
    i, n = 0, len(frames)
    while i < n:
        t, y, _ = frames[i]
        before = [b for (tb, b, _) in frames[max(0, i - 8):i] if t - 1.0 <= tb < t]
        if before:
            ref = sum(before) / len(before)
            if y - ref >= FLASH_JUMP:
                j = i + 1
                while j < n and frames[j][0] - t <= FLASH_BACK and frames[j][1] > ref + FLASH_SETTLE:
                    j += 1
                if j < n and frames[j][0] - t <= FLASH_BACK:  # it came back: a flash, not a cut to a bright scene
                    if not events or events[-1].kind != "screen_flash" or t - events[-1].end > 2.0:
                        events.append(VisualEvent("screen_flash", t, frames[j][0], t, round(y - ref, 1)))
                    i = j
        i += 1
    return sorted(events, key=lambda e: e.start)


def window_motion_score(motion: list[Motion], usual: float, start: float, end: float) -> float | None:
    """How far above the recording's usual motion the window's busiest second was (0–100)."""
    times = [t for t, _ in motion]
    lo, hi = bisect_left(times, start), bisect_right(times, end)
    if lo >= hi:
        return None
    peak = max(m for _, m in motion[lo:hi])
    if peak < ACTION_MIN:
        return 0.0
    return round(max(0.0, min(100.0, (peak / usual - 1) / (FULL_SCORE_RATIO - 1) * 100)), 1)


def window_events(events: list[VisualEvent], start: float, end: float) -> list[VisualEvent]:
    return [e for e in events if e.start <= end and start <= e.end]
