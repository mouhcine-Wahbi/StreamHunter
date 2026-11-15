"""Per-stream chat analyzer: window → detectors → aggregator → candidate drafts."""

from __future__ import annotations

from datetime import datetime

from app.detection.base_detector import Detector
from app.detection.chat_spike_detector import ChatSpikeDetector
from app.detection.emote_detector import EmoteDetector
from app.detection.event_aggregator import EventAggregator
from app.detection.keyword_detector import KeywordDetector
from app.detection.models import CandidateDraft, ChatMessage, DetectorEvent
from app.detection.reaction_detector import ReactionDetector
from app.detection.window import RollingChatWindow
from app.domain.enums import Platform


def default_detectors() -> list[Detector]:
    return [ChatSpikeDetector(), EmoteDetector(), KeywordDetector(), ReactionDetector()]


class StreamAnalyzer:
    def __init__(self, platform: Platform, broadcaster_id: str, *, broadcaster_login: str | None = None,
                 detectors: list[Detector] | None = None):
        self.platform = platform
        self.broadcaster_id = broadcaster_id
        self.window = RollingChatWindow(broadcaster_login)
        self.detectors = detectors or default_detectors()
        self.aggregator = EventAggregator(platform, broadcaster_id)
        self.last_events: list[DetectorEvent] = []
        self.messages_seen = 0

    def configure(self, *, languages: set[str], custom_keywords: set[str]) -> None:
        self.window.configure(languages, custom_keywords)

    def add(self, msg: ChatMessage) -> None:
        self.messages_seen += 1
        self.window.add(msg)

    def evaluate(self, now: datetime) -> CandidateDraft | None:
        """Call once per bucket (every 5 s). Returns a finished candidate, if any."""
        features, baseline = self.window.features(now)
        events: list[DetectorEvent] = []
        for d in self.detectors:
            events.extend(d.evaluate(features, baseline, platform=self.platform, broadcaster_id=self.broadcaster_id))
        self.last_events = events
        draft = self.aggregator.push(events, now)
        self.window.prune(now)
        return draft

    def flush(self) -> CandidateDraft | None:
        return self.aggregator.flush()

    def activity(self, now: datetime) -> dict[str, object]:
        out = self.window.activity(now)
        out["active_signals"] = sorted({e.event_type for e in self.last_events})
        out["messages_seen"] = self.messages_seen
        return out
