"""What a recording *sounds like*, second by second: laughter, cheering, screaming (Phase 7).

A sound classifier (YAMNet, see app/clipping/sound_classifier.py) gives, for each second of
audio, the probability of each kind of sound. This module turns those per-second values into
events ("laughter from 12 s to 17 s") and window signals for highlight candidates. It is pure
logic so it can be tested without the model.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass

from app.domain.enums import HighlightCategory as HC

# Kind of sound → the YAMNet (AudioSet) class names that make it up. A second's value for a kind
# is the highest probability among its classes.
SOUND_KINDS: dict[str, tuple[str, ...]] = {
    "laughter": ("Laughter", "Baby laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle"),
    "cheering": ("Cheering", "Applause", "Whoop"),
    "screaming": ("Screaming", "Shout", "Yell", "Children shouting"),
}
KIND_CATEGORY = {
    "laughter": HC.FUNNY.value,
    "cheering": HC.EXCITING.value,
    "screaming": HC.UNEXPECTED_REACTION.value,
}
KIND_LABEL = {"laughter": "Laughter", "cheering": "Cheering", "screaming": "Screaming or shouting"}

EVENT_THRESHOLD = 0.3  # a second counts as "laughter" etc. at this probability or more
MERGE_GAP = 2.0  # seconds between two runs that still make one event
MIN_EVENT_SECONDS = 2.0  # shorter runs are usually a single misheard sound
FULL_SCORE_AT = 0.6  # probability that maps to a sound score of 100
STRONG = 0.45  # enough to name the moment's category and give a reason

Frame = tuple[float, dict[str, float]]  # (second in the file, {kind: probability 0–1})


@dataclass(frozen=True, slots=True)
class SoundEvent:
    kind: str
    start: float
    end: float
    peak_t: float
    peak: float  # highest probability in the event (0–1)

    @property
    def score(self) -> float:
        return sound_score(self.peak)


def sound_score(probability: float) -> float:
    """0–100 signal from a classifier probability (FULL_SCORE_AT and above → 100)."""
    return round(max(0.0, min(1.0, probability / FULL_SCORE_AT)) * 100, 1)


def detect_sound_events(frames: list[Frame]) -> list[SoundEvent]:
    """Runs of seconds where one kind of sound is likely, merged across short gaps."""
    events: list[SoundEvent] = []
    for kind in SOUND_KINDS:
        runs: list[list[tuple[float, float]]] = []
        for t, probs in frames:
            p = probs.get(kind, 0.0)
            if p < EVENT_THRESHOLD:
                continue
            if runs and t - runs[-1][-1][0] <= MERGE_GAP + 1:
                runs[-1].append((t, p))
            else:
                runs.append([(t, p)])
        for run in runs:
            start, end = run[0][0], run[-1][0] + 1
            if end - start < MIN_EVENT_SECONDS:
                continue
            pt, pp = max(run, key=lambda x: x[1])
            events.append(SoundEvent(kind, start, end, pt, round(pp, 3)))
    return sorted(events, key=lambda e: e.start)


def window_sounds(frames: list[Frame], start: float, end: float) -> dict[str, float] | None:
    """Highest probability per kind of sound within [start, end], or None when not covered."""
    times = [t for t, _ in frames]
    lo, hi = bisect_left(times, start), bisect_right(times, end)
    if lo >= hi:
        return None
    return {kind: round(max(frames[i][1].get(kind, 0.0) for i in range(lo, hi)), 3) for kind in SOUND_KINDS}


def strongest(sounds: dict[str, float] | None) -> tuple[str, float] | None:
    """The most likely kind of sound, if it is likely enough to name the moment."""
    if not sounds:
        return None
    kind, p = max(sounds.items(), key=lambda kv: kv[1])
    return (kind, p) if p >= STRONG else None


def reason_for(kind: str, probability: float) -> str:
    return f"{KIND_LABEL[kind]} in the audio ({round(probability * 100)}% sure)"
