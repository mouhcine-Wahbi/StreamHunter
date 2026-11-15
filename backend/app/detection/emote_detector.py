"""Emote waves and repeated phrases (copy-paste waves) across many distinct chatters."""

from __future__ import annotations

from app.detection import lexicon
from app.detection.base_detector import Detector, strictest
from app.detection.models import DetectorEvent
from app.detection.window import Baseline, WindowFeatures
from app.domain.enums import Platform



class EmoteDetector(Detector):
    name = "emote_wave"

    def evaluate(self, f: WindowFeatures, base: Baseline, *, platform: Platform, broadcaster_id: str) -> list[DetectorEvent]:
        out: list[DetectorEvent] = []
        if f.unique_users == 0:
            return out

        if f.emote_users:
            emote, users = max(f.emote_users.items(), key=lambda kv: kv[1])
            share = users / f.unique_users
            usual = base.per_window_emote_users.get(emote, 0.0)
            # Must be unusual for *this* stream: ≥ 2× its normal per-window usage.
            level = strictest(lambda t: users >= t.min_users and share >= t.share and users >= 2 * usual + 1)
            if level is not None:
                out.append(
                    DetectorEvent(
                        event_type="emote_wave",
                        timestamp=f.end,
                        window_start=f.start,
                        platform=platform,
                        broadcaster_id=broadcaster_id,
                        confidence=round(min(0.97, 0.4 + share * 0.6), 3),
                        score=round(min(100.0, 30 + users * 2 + share * 30), 1),
                        strictness=level,
                        reason=f"'{emote}' used by {users} chatters ({share:.0%} of chat)",
                        category_hint=lexicon.EMOTE_CATEGORIES.get(emote.lower()),
                        metadata={"emote": emote, "users": users, "share": round(share, 2), "usual": round(usual, 2)},
                    )
                )

        emote_names = {e.casefold() for e in f.emote_users}
        # Emote-only messages are already covered by the emote wave above.
        phrases = {p: n for p, n in f.phrase_users.items() if not set(p.split()) <= emote_names}
        if phrases:
            phrase, users = max(phrases.items(), key=lambda kv: kv[1])
            share = users / f.unique_users
            usual = base.per_window_phrase_users.get(phrase, 0.0)
            # Common lines ("hi chat", "gg") are part of this stream's normal chat: must be unusual.
            level = strictest(
                lambda t: users >= t.min_users and share >= t.share and len(phrase) >= 2 and users >= 2 * usual + 2
            )
            if level is not None:
                hint = f.phrase_categories.get(phrase)
                out.append(
                    DetectorEvent(
                        event_type="repeated_phrase",
                        timestamp=f.end,
                        window_start=f.start,
                        platform=platform,
                        broadcaster_id=broadcaster_id,
                        confidence=round(min(0.95, 0.35 + share * 0.6), 3),
                        score=round(min(100.0, 25 + users * 2 + share * 25), 1),
                        strictness=level,
                        reason=f"{users} chatters posted the same message",
                        category_hint=None if hint == "custom" else hint,
                        # The phrase itself is short, normalized chat text: kept only as an aggregate.
                        metadata={"phrase": phrase[:40], "users": users, "share": round(share, 2)},
                    )
                )
        return out
