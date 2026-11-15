"""Reaction waves ("LOL", "NO WAY", "jajaja", "kkkk", custom phrases) and sentiment shifts."""

from __future__ import annotations

from app.detection.base_detector import Detector, strictest
from app.detection.models import DetectorEvent
from app.detection.window import Baseline, WindowFeatures
from app.domain.enums import Platform

LABEL = {"funny": "laughing", "shock": "shocked", "hype": "hyped", "sad": "sad", "custom": "using your keywords"}


class ReactionDetector(Detector):
    name = "reaction"

    def evaluate(self, f: WindowFeatures, base: Baseline, *, platform: Platform, broadcaster_id: str) -> list[DetectorEvent]:
        out: list[DetectorEvent] = []
        if f.unique_users == 0 or not f.reaction_users:
            return out
        category, users = max(f.reaction_users.items(), key=lambda kv: kv[1])
        share = users / f.unique_users
        usual = base.per_window_reaction_users.get(category, 0.0)
        level = strictest(lambda t: users >= t.min_users and share >= t.share and users >= 2 * usual + 1)
        if level is not None:
            out.append(
                DetectorEvent(
                    event_type="reaction",
                    timestamp=f.end,
                    window_start=f.start,
                    platform=platform,
                    broadcaster_id=broadcaster_id,
                    confidence=round(min(0.95, 0.4 + share * 0.55), 3),
                    score=round(min(100.0, 30 + users * 2.2 + share * 30), 1),
                    strictness=level,
                    reason=f"{users} chatters {LABEL.get(category, 'reacting')} ({share:.0%} of chat)",
                    category_hint=None if category == "custom" else category,
                    metadata={"reaction": category, "users": users, "share": round(share, 2), "usual": round(usual, 2),
                              "reaction_intensity": round(min(100.0, share * 100), 1)},
                )
            )

        # Sudden change of mood relative to this stream's usual mood.
        reacting = sum(f.reaction_users.values())
        if f.sentiment is not None and base.sentiment_mean is not None and base.ready:
            delta = f.sentiment - base.sentiment_mean
            level = strictest(lambda t: abs(delta) >= 0.4 + t.share and reacting >= t.min_users)
            if level is not None:
                out.append(
                    DetectorEvent(
                        event_type="sentiment_shift",
                        timestamp=f.end,
                        window_start=f.start,
                        platform=platform,
                        broadcaster_id=broadcaster_id,
                        confidence=round(min(0.9, 0.3 + abs(delta) / 2), 3),
                        score=round(min(100.0, 25 + abs(delta) * 40), 1),
                        strictness=level,
                        reason=f"Chat mood turned {'positive' if delta > 0 else 'negative'} suddenly",
                        category_hint="hype" if delta > 0 else "sad",
                        metadata={"sentiment": round(f.sentiment, 2), "baseline": round(base.sentiment_mean, 2)},
                    )
                )
        return out
