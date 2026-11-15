from __future__ import annotations

from enum import StrEnum


class Platform(StrEnum):
    TWITCH = "twitch"
    KICK = "kick"


class ConnectionStatus(StrEnum):
    NOT_CONNECTED = "not_connected"
    CONNECTED = "connected"
    EXPIRED = "expired"
    REVOKED = "revoked"
    ERROR = "error"


class MonitoringSessionStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"  # browser lease expired; resumes when the extension is back
    ENDED = "ended"
    ERROR = "error"


class ClipStatus(StrEnum):
    """Shared lifecycle of highlight candidates and clips (see ARCHITECTURE.md §6)."""

    DETECTED = "detected"
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    CREATION_REQUESTED = "creation_requested"
    CREATED = "created"
    EXPORTING = "exporting"
    READY = "ready"
    FAILED = "failed"
    PUBLISHED = "published"
    UNSUPPORTED = "unsupported"


class HighlightCategory(StrEnum):
    FUNNY = "funny_moment"
    UNEXPECTED_REACTION = "unexpected_reaction"
    EMOTIONAL = "emotional_moment"
    EXCITING = "exciting_moment"
    CONVERSATION = "interesting_conversation"
    AUDIENCE_REACTION = "audience_reaction"
    GAMEPLAY = "gameplay_highlight"
    EDUCATIONAL = "educational_insight"
    OTHER = "other"
    UNKNOWN = "unknown"
