"""Highlight scoring with renormalized weights and evidence-based categories.

The full model weighs chat, audio, visual and context signals. Only chat exists today:
missing signals are *excluded* (not counted as zero) and the remaining weights are
renormalized, so a strong chat-only moment can still score high.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping

from app.detection.models import DetectorEvent
from app.domain.enums import HighlightCategory as HC

DEFAULT_WEIGHTS: dict[str, float] = {"chat": 0.25, "audio": 0.30, "visual": 0.20, "context": 0.25}

# Detector category hints → highlight categories.
HINT_TO_CATEGORY = {
    "funny": HC.FUNNY,
    "shock": HC.UNEXPECTED_REACTION,
    "hype": HC.EXCITING,
    "sad": HC.EMOTIONAL,
}


def calculate_score(signals: Mapping[str, float | None], weights: Mapping[str, float]) -> float:
    """Weighted mean over the signals that are actually available (0–100)."""
    available = {k: v for k, v in signals.items() if v is not None and k in weights and weights[k] > 0}
    if not available:
        return 0.0
    total = sum(weights[k] for k in available)
    return sum(available[k] * weights[k] for k in available) / total


def chat_signal(events: list[DetectorEvent]) -> tuple[float, float]:
    """(score 0–100, confidence 0–1) from the strongest event per detector type.

    Corroboration across *different* detectors raises both, more than repeats of one.
    """
    best: dict[str, DetectorEvent] = {}
    for e in events:
        if e.event_type not in best or e.score > best[e.event_type].score:
            best[e.event_type] = e
    if not best:
        return 0.0, 0.0
    scores = sorted((e.score for e in best.values()), reverse=True)
    score = min(100.0, scores[0] + sum(6.0 for _ in scores[1:]))
    miss = 1.0
    for e in best.values():
        miss *= 1 - e.confidence
    return round(score, 1), round(min(0.99, 1 - miss), 3)


def infer_category(events: list[DetectorEvent]) -> str:
    """Category from evidence only; "audience_reaction" for volume/clip requests without a mood,
    "unknown" when nothing supports a category."""
    votes: Counter[str] = Counter()
    for e in events:
        if e.category_hint in HINT_TO_CATEGORY:
            votes[HINT_TO_CATEGORY[e.category_hint].value] += e.score
    if votes:
        category, weight = votes.most_common(1)[0]
        # Require the winning mood to carry real weight, not a single weak hint.
        if weight >= 40:
            return category
    if any(e.event_type in {"chat_spike", "clip_request", "emote_wave", "repeated_phrase"} for e in events):
        return HC.AUDIENCE_REACTION.value
    return HC.UNKNOWN.value


def breakdown(events: list[DetectorEvent], chat: float, weights: Mapping[str, float]) -> dict[str, object]:
    detectors: dict[str, dict[str, object]] = {}
    for e in events:
        d = detectors.setdefault(e.event_type, {"max_score": 0.0, "max_confidence": 0.0, "windows": 0})
        d["max_score"] = max(float(d["max_score"]), e.score)  # type: ignore[arg-type]
        d["max_confidence"] = max(float(d["max_confidence"]), e.confidence)  # type: ignore[arg-type]
        d["windows"] = int(d["windows"]) + 1  # type: ignore[arg-type]
    return {
        "chat": chat,
        "audio": None,  # not analysed yet (Phase 7)
        "visual": None,
        "context": None,
        "weights": dict(weights),
        "active_signals": ["chat"],
        "detectors": detectors,
    }
