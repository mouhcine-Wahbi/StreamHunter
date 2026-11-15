"""Finds the official platform recording (VOD) for monitoring sessions and links highlights to it.

Twitch: Get Videos (type=archive) → link with ?t= offset. Kick: no VOD API (unsupported).
StreamHunter only *links* to VODs; it never downloads them.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.domain.enums import Platform
from app.errors import AppError
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.integrations.twitch.clips import find_archive_vod
from app.models import MonitoringSession

log = logging.getLogger("streamhunter.vod")
RECHECK_AFTER = timedelta(minutes=30)
MAX_AGE = timedelta(days=7)


def vod_timestamp(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    s = max(0, int(seconds))
    return f"{s // 3600}h{(s % 3600) // 60}m{s % 60}s"


def vod_link_at(vod_url: str | None, offset: float | None) -> str | None:
    t = vod_timestamp(offset)
    return f"{vod_url}?t={t}" if vod_url and t else None


async def lookup_vod(session: MonitoringSession, registry: PlatformRegistry) -> bool:
    session.vod_checked_at = utcnow()
    if session.platform != Platform.TWITCH.value:
        return False
    adapter = registry.get(Platform.TWITCH)
    if not isinstance(adapter, TwitchAdapter) or adapter.helix is None:
        return False
    v = await find_archive_vod(adapter.helix, session.streamer.platform_user_id, session.broadcast_started_at)
    if v is None:
        return False
    session.vod_id, session.vod_url = v.id, v.url
    return True


async def refresh_vods(db: AsyncSession, registry: PlatformRegistry, *, limit: int = 5) -> int:
    """Called from the monitoring cycle: a few Twitch sessions without a VOD, rechecked every 30 min."""
    now = utcnow()
    rows = (await db.scalars(
        select(MonitoringSession).where(
            MonitoringSession.platform == Platform.TWITCH.value,
            MonitoringSession.vod_id.is_(None),
            MonitoringSession.started_at > now - MAX_AGE,
            or_(MonitoringSession.vod_checked_at.is_(None), MonitoringSession.vod_checked_at < now - RECHECK_AFTER),
        ).limit(limit)
    )).unique().all()
    found = 0
    for s in rows:
        try:
            found += await lookup_vod(s, registry)
        except AppError as exc:
            log.info("vod_lookup_failed", extra={"session_id": s.id, "reason": exc.message})
            break  # platform trouble: try again next cycle
    await db.flush()
    return found
