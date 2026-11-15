"""Data retention: deletes old detection events and stale auth artefacts.

* stream_events older than each user's `privacy.retentionDays` (default 30).
* oauth_states expired for more than a day.
* auth_sessions expired or revoked for more than 30 days.
Highlights, clips and session history are user content and are kept.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.models import AuthSession, MonitoringSession, OAuthState, StreamEvent, User, UserSettings
from app.schemas.settings import PrivacySettings

log = logging.getLogger("streamhunter.retention")
DEFAULT_DAYS = PrivacySettings().retentionDays


@dataclass(slots=True)
class SweepResult:
    events: int = 0
    oauth_states: int = 0
    auth_sessions: int = 0


async def sweep(db: AsyncSession) -> SweepResult:
    now = utcnow()
    result = SweepResult()
    days_by_user: dict[int, int] = {}
    for uid, settings in (await db.execute(select(UserSettings.user_id, UserSettings.settings))).all():
        try:
            days_by_user[uid] = int(settings.get("privacy", {}).get("retentionDays", DEFAULT_DAYS))
        except (TypeError, ValueError, AttributeError):
            days_by_user[uid] = DEFAULT_DAYS

    for uid in (await db.scalars(select(User.id))).all():
        cutoff = now - timedelta(days=days_by_user.get(uid, DEFAULT_DAYS))
        res = await db.execute(
            delete(StreamEvent).where(
                StreamEvent.created_at < cutoff,
                StreamEvent.session_id.in_(select(MonitoringSession.id).where(MonitoringSession.user_id == uid)),
            )
        )
        result.events += res.rowcount or 0

    res = await db.execute(delete(OAuthState).where(OAuthState.expires_at < now - timedelta(days=1)))
    result.oauth_states = res.rowcount or 0
    old = now - timedelta(days=30)
    res = await db.execute(
        delete(AuthSession).where(or_(AuthSession.expires_at < old, AuthSession.revoked_at < old))
    )
    result.auth_sessions = res.rowcount or 0
    if result.events or result.oauth_states or result.auth_sessions:
        log.info("retention_sweep", extra={"events": result.events, "oauth_states": result.oauth_states,
                                           "auth_sessions": result.auth_sessions})
    return result
