"""Importing this package registers every model on Base.metadata (needed by Alembic)."""

from app.models.monitoring import Clip, HighlightCandidate, MonitoringLease, MonitoringSession, StreamEvent
from app.models.streamer import Streamer, UserStreamer
from app.models.user import AuthSession, OAuthState, PlatformConnection, User, UserSettings

__all__ = [
    "AuthSession",
    "Clip",
    "HighlightCandidate",
    "MonitoringLease",
    "MonitoringSession",
    "OAuthState",
    "PlatformConnection",
    "StreamEvent",
    "Streamer",
    "User",
    "UserSettings",
    "UserStreamer",
]
