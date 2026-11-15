"""Fetches live status from the platforms and updates the shared streamer rows."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.domain.enums import Platform
from app.errors import AppError
from app.integrations.base import LiveStatus
from app.integrations.registry import PlatformRegistry
from app.models import Streamer, User, UserStreamer

# Don't ask the platform again about a streamer checked this recently (rate-limit friendly).
MIN_RECHECK = timedelta(seconds=30)


@dataclass(slots=True)
class RefreshSummary:
    checked: int = 0
    live: int = 0
    skipped_recent: int = 0
    unavailable: dict[str, str] = field(default_factory=dict)  # platform -> reason


def apply_status(s: Streamer, st: LiveStatus | None) -> None:
    now = utcnow()
    s.status_checked_at = now
    if st is None:
        return  # platform did not report it: keep last known values, but record the check
    s.is_live = st.is_live
    if st.is_live:
        s.current_title = st.title
        s.current_category = st.category
        s.viewer_count = st.viewer_count
        s.stream_started_at = st.started_at
    else:
        # Clear live-only fields so stale data is never shown as current.
        s.current_title = None
        s.current_category = None
        s.viewer_count = None
        s.stream_started_at = None


class StreamStatusService:
    def __init__(self, db: AsyncSession, registry: PlatformRegistry):
        self.db = db
        self.registry = registry

    async def refresh_streamers(self, streamers: list[Streamer], *, force: bool = False) -> RefreshSummary:
        summary = RefreshSummary()
        now = utcnow()
        by_platform: dict[Platform, list[Streamer]] = defaultdict(list)
        for s in streamers:
            if not force and s.status_checked_at and now - s.status_checked_at < MIN_RECHECK:
                summary.skipped_recent += 1
                continue
            by_platform[Platform(s.platform)].append(s)

        for platform, group in by_platform.items():
            try:
                statuses = await self.registry.get(platform).get_live_status([s.platform_user_id for s in group])
            except AppError as exc:
                summary.unavailable[platform.value] = exc.message
                continue
            for s in group:
                apply_status(s, statuses.get(s.platform_user_id))
                summary.checked += 1
        summary.live = sum(1 for s in streamers if s.is_live)
        await self.db.flush()
        return summary

    async def refresh_watchlist(self, user: User) -> RefreshSummary:
        rows = await self.db.scalars(
            select(Streamer).join(UserStreamer, UserStreamer.streamer_id == Streamer.id).where(UserStreamer.user_id == user.id)
        )
        return await self.refresh_streamers(list(rows.unique()))
