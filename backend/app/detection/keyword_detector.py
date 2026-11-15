"""Explicit "clip it" requests from distinct chatters: a strong, intent-bearing signal."""

from __future__ import annotations

from app.detection.base_detector import Detector, strictest
from app.detection.models import DetectorEvent
from app.detection.window import Baseline, WindowFeatures
from app.domain.enums import Platform


class KeywordDetector(Detector):
    name = "clip_request"

    def evaluate(self, f: WindowFeatures, base: Baseline, *, platform: Platform, broadcaster_id: str) -> list[DetectorEvent]:
        n = f.clip_requesters
        # Half the usual minimum is enough: several people independently asking is meaningful.
        level = strictest(lambda t: n >= max(2, t.min_users // 2))
        if level is None:
            return []
        return [
            DetectorEvent(
                event_type=self.name,
                timestamp=f.end,
                window_start=f.start,
                platform=platform,
                broadcaster_id=broadcaster_id,
                confidence=round(min(0.98, 0.55 + 0.08 * n), 3),
                score=round(min(100.0, 45 + 7 * n), 1),
                strictness=level,
                reason=f"{n} chatters asked to clip it",
                metadata={"clip_requests": n, "unique_users": f.unique_users},
            )
        ]
