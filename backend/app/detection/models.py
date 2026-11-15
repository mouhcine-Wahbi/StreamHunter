"""Platform-independent data types for chat intelligence."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import IntEnum
from typing import Any

from app.domain.enums import Platform


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """One chat message, normalized from any platform. Never persisted."""

    platform: Platform
    broadcaster_id: str  # platform user id of the channel
    user_id: str  # platform user id of the chatter
    user_login: str
    text: str
    emotes: tuple[str, ...]  # emote names as used in the message (e.g. "KEKW")
    received_at: datetime  # UTC; used for bucketing (consistent clock across platforms)


class Strictness(IntEnum):
    """The strictest sensitivity level a detection still satisfies.

    A user with sensitivity "low" only sees detections that pass LOW (the strictest
    thresholds); "high" users see everything that passes HIGH.
    """

    HIGH = 1  # most permissive thresholds
    MEDIUM = 2
    LOW = 3  # strictest thresholds

    @classmethod
    def for_setting(cls, sensitivity: str) -> Strictness:
        return {"high": cls.HIGH, "medium": cls.MEDIUM, "low": cls.LOW}.get(sensitivity, cls.MEDIUM)


@dataclass(frozen=True, slots=True)
class Thresholds:
    z: float  # standard deviations above the stream's own baseline
    ratio: float  # multiple of the baseline rate
    min_users: int  # distinct chatters required
    share: float  # fraction of window chatters for emote/reaction waves


THRESHOLDS: dict[Strictness, Thresholds] = {
    Strictness.HIGH: Thresholds(z=1.8, ratio=1.6, min_users=3, share=0.2),
    Strictness.MEDIUM: Thresholds(z=2.5, ratio=2.0, min_users=5, share=0.3),
    Strictness.LOW: Thresholds(z=3.5, ratio=2.8, min_users=8, share=0.4),
}


@dataclass(slots=True)
class DetectorEvent:
    """Standardized detector output (see the spec's event format)."""

    event_type: str  # chat_spike | emote_wave | repeated_phrase | clip_request | reaction | sentiment_shift
    timestamp: datetime  # end of the analysis window
    window_start: datetime
    platform: Platform
    broadcaster_id: str
    confidence: float  # 0..1
    score: float  # 0..100 contribution to the chat signal
    strictness: Strictness
    reason: str  # human-readable explanation
    category_hint: str | None = None  # funny | shock | hype | sad | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class CandidateDraft:
    platform: Platform
    broadcaster_id: str
    start_at: datetime  # first window that fired
    end_at: datetime  # last window that fired
    peak_at: datetime  # window with the highest detector score
    score: float  # 0..100
    confidence: float  # 0..1
    category: str
    reasons: list[str]
    signal_breakdown: dict[str, Any]
    strictness: Strictness
    events: list[DetectorEvent]
