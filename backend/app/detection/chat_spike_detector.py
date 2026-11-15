"""Sudden chat volume increase, relative to this stream's own baseline.

Uses *effective* messages (each chatter counts at most PER_USER_CAP per 5 s bucket), so
one person spamming is not an audience reaction, and requires a minimum of distinct chatters.
"""

from __future__ import annotations

import math

from app.detection.base_detector import Detector, strictest
from app.detection.models import DetectorEvent
from app.detection.window import WINDOW_BUCKETS, Baseline, WindowFeatures
from app.domain.enums import Platform


class ChatSpikeDetector(Detector):
    name = "chat_spike"

    def evaluate(self, f: WindowFeatures, base: Baseline, *, platform: Platform, broadcaster_id: str) -> list[DetectorEvent]:
        if not base.ready:
            return []
        per_bucket = f.effective_messages / WINDOW_BUCKETS
        # Poisson-ish noise floor: quiet chats have std≈0, so use sqrt(mean) and ≥1.
        spread = max(base.std, math.sqrt(base.mean), 1.0)
        z = (per_bucket - base.mean) / spread
        ratio = per_bucket / max(base.mean, 0.5)
        level = strictest(lambda t: z >= t.z and ratio >= t.ratio and f.unique_users >= t.min_users)
        if level is None:
            return []
        score = min(100.0, 35 + 10 * (ratio - 1) + 4 * z + min(15, f.unique_users / 4))
        confidence = min(0.99, 1 - math.exp(-max(0.0, z) / 3))
        return [
            DetectorEvent(
                event_type=self.name,
                timestamp=f.end,
                window_start=f.start,
                platform=platform,
                broadcaster_id=broadcaster_id,
                confidence=round(confidence, 3),
                score=round(score, 1),
                strictness=level,
                reason=f"Chat activity {ratio:.1f}× its normal level ({f.unique_users} chatters in 15 s)",
                metadata={
                    "messages_per_second": round(f.effective_messages / (WINDOW_BUCKETS * 5), 2),
                    "unique_users": f.unique_users,
                    "baseline_per_bucket": round(base.mean, 2),
                    "ratio": round(ratio, 2),
                    "z": round(z, 2),
                    "raw_messages": f.raw_messages,
                },
            )
        ]
