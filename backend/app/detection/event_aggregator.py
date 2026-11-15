"""Groups detector events into moments and turns finished moments into candidates.

A moment opens on the first event, extends while events keep coming (gaps ≤ QUIET_SECONDS),
and closes after QUIET_SECONDS without events or MAX_MOMENT_SECONDS. A short cooldown
prevents one long reaction from producing a string of near-duplicate candidates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.detection.models import CandidateDraft, DetectorEvent, Strictness
from app.detection.scoring_engine import DEFAULT_WEIGHTS, breakdown, calculate_score, chat_signal, infer_category
from app.domain.enums import Platform

QUIET_SECONDS = 10
MAX_MOMENT_SECONDS = 90
COOLDOWN_SECONDS = 20
MIN_SCORE = 35.0  # below this a moment is noise and not stored at all
# Supporting signals alone never make a candidate; one of these must be present.
PRIMARY = frozenset({"chat_spike", "emote_wave", "clip_request", "reaction"})


@dataclass(slots=True)
class _Moment:
    start: datetime
    last: datetime
    events: list[DetectorEvent] = field(default_factory=list)


class EventAggregator:
    def __init__(self, platform: Platform, broadcaster_id: str, weights: dict[str, float] | None = None):
        self.platform = platform
        self.broadcaster_id = broadcaster_id
        self.weights = weights or DEFAULT_WEIGHTS
        self._moment: _Moment | None = None
        self._cooldown_until: datetime | None = None

    def push(self, events: list[DetectorEvent], now: datetime) -> CandidateDraft | None:
        draft: CandidateDraft | None = None
        m = self._moment
        if m and (now - m.last > timedelta(seconds=QUIET_SECONDS) or now - m.start > timedelta(seconds=MAX_MOMENT_SECONDS)):
            draft = self._finish(m)
            self._moment = None
            self._cooldown_until = now + timedelta(seconds=COOLDOWN_SECONDS)
            m = None
        if events:
            if m is None:
                if self._cooldown_until and now < self._cooldown_until and draft is None:
                    return None
                start = min(e.window_start for e in events)
                self._moment = _Moment(start=start, last=now, events=list(events))
            else:
                m.events.extend(events)
                m.last = now
        return draft

    def flush(self) -> CandidateDraft | None:
        """Close any open moment (stream ended / collector stopped)."""
        m, self._moment = self._moment, None
        return self._finish(m) if m else None

    def _finish(self, m: _Moment) -> CandidateDraft | None:
        if not any(e.event_type in PRIMARY for e in m.events):
            return None
        chat, confidence = chat_signal(m.events)
        score = calculate_score({"chat": chat, "audio": None, "visual": None, "context": None}, self.weights)
        if score < MIN_SCORE:
            return None
        peak = max(m.events, key=lambda e: e.score)
        # Reasons: the strongest explanation per detector type, strongest first.
        best: dict[str, DetectorEvent] = {}
        for e in m.events:
            if e.event_type not in best or e.score > best[e.event_type].score:
                best[e.event_type] = e
        reasons = [e.reason for e in sorted(best.values(), key=lambda e: e.score, reverse=True)]
        # A moment is as strict as its most convincing primary detector.
        strictness = max((e.strictness for e in m.events if e.event_type in PRIMARY), default=Strictness.HIGH)
        return CandidateDraft(
            platform=self.platform,
            broadcaster_id=self.broadcaster_id,
            start_at=m.start,
            end_at=max(e.timestamp for e in m.events),
            peak_at=peak.timestamp,
            score=round(score, 1),
            confidence=confidence,
            category=infer_category(m.events),
            reasons=reasons,
            signal_breakdown=breakdown(m.events, chat, self.weights),
            strictness=strictness,
            events=list(best.values()),
        )
