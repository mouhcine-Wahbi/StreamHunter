"""Watchlist management. Every query is scoped to the requesting user."""

from __future__ import annotations

import logging

from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ConflictError, NotFoundError
from app.integrations.base import ChannelInfo, StreamingPlatform
from app.models import Streamer, User, UserStreamer
from app.schemas.common import Page
from app.schemas.streamer import StreamerCreate, StreamerOut, StreamerUpdate, StreamStatusOut

log = logging.getLogger("streamhunter.streamers")


def to_out(entry: UserStreamer) -> StreamerOut:
    s = entry.streamer
    return StreamerOut(
        id=s.id,
        platform=s.platform,
        platform_user_id=s.platform_user_id,
        username=s.username,
        display_name=s.display_name,
        profile_image_url=s.profile_image_url,
        is_live=s.is_live,
        current_title=s.current_title,
        current_category=s.current_category,
        viewer_count=s.viewer_count,
        stream_started_at=s.stream_started_at,
        status_checked_at=s.status_checked_at,
        monitoring_enabled=entry.monitoring_enabled,
        is_favorite=entry.is_favorite,
        added_at=entry.created_at,
        updated_at=s.updated_at,
    )


def to_status(s: Streamer) -> StreamStatusOut:
    return StreamStatusOut(
        streamer_id=s.id,
        platform=s.platform,
        is_live=s.is_live,
        title=s.current_title,
        category=s.current_category,
        viewer_count=s.viewer_count,
        started_at=s.stream_started_at,
        last_checked_at=s.status_checked_at,
    )


class StreamerService:
    def __init__(self, db: AsyncSession, user: User):
        self.db = db
        self.user = user

    def _entries(self):  # type: ignore[no-untyped-def]
        return select(UserStreamer).join(UserStreamer.streamer).where(UserStreamer.user_id == self.user.id)

    async def list(self, *, limit: int, offset: int, live_only: bool = False) -> Page[StreamerOut]:
        q = self._entries()
        if live_only:
            q = q.where(Streamer.is_live.is_(True))
        total = await self.db.scalar(select(func.count()).select_from(q.subquery())) or 0
        rows = (
            await self.db.scalars(
                q.order_by(UserStreamer.is_favorite.desc(), Streamer.display_name).limit(limit).offset(offset)
            )
        ).unique()
        return Page(items=[to_out(e) for e in rows], total=total, limit=limit, offset=offset)

    async def get_entry(self, streamer_id: int) -> UserStreamer:
        entry = await self.db.scalar(self._entries().where(UserStreamer.streamer_id == streamer_id))
        if entry is None:
            # Same response whether the streamer doesn't exist or belongs to someone else's list.
            raise NotFoundError("Streamer not found in your watchlist")
        return entry

    async def add(self, req: StreamerCreate, adapter: StreamingPlatform) -> StreamerOut:
        channel = await adapter.get_channel(req.username)
        if channel is None:
            raise NotFoundError(f"No {req.platform.value} channel named '{req.username}'", code="channel_not_found")
        streamer = await self._upsert_streamer(channel)

        already = await self.db.scalar(
            select(UserStreamer.id).where(UserStreamer.user_id == self.user.id, UserStreamer.streamer_id == streamer.id)
        )
        if already is not None:
            raise ConflictError(
                "This streamer is already in your watchlist",
                code="already_in_watchlist",
                details={"streamer_id": streamer.id},
            )
        entry = UserStreamer(user_id=self.user.id, streamer_id=streamer.id, monitoring_enabled=True)
        self.db.add(entry)
        await self.db.flush()
        await self._sync_aggregate(streamer)
        await self.db.refresh(entry, ["streamer", "created_at"])
        log.info("watchlist_added", extra={"user_id": self.user.id, "streamer_id": streamer.id})
        return to_out(entry)

    async def update(self, streamer_id: int, patch: StreamerUpdate) -> StreamerOut:
        entry = await self.get_entry(streamer_id)
        if patch.monitoring_enabled is not None:
            entry.monitoring_enabled = patch.monitoring_enabled
        if patch.is_favorite is not None:
            entry.is_favorite = patch.is_favorite
        await self.db.flush()
        await self._sync_aggregate(entry.streamer)
        return to_out(entry)

    async def remove(self, streamer_id: int) -> None:
        entry = await self.get_entry(streamer_id)
        streamer = entry.streamer
        await self.db.delete(entry)
        await self.db.flush()
        await self._sync_aggregate(streamer)

    async def _upsert_streamer(self, ch: ChannelInfo) -> Streamer:
        key = (Streamer.platform == ch.platform.value, Streamer.platform_user_id == ch.platform_user_id)
        streamer = await self.db.scalar(select(Streamer).where(*key))
        if streamer is None:
            streamer = Streamer(platform=ch.platform.value, platform_user_id=ch.platform_user_id, monitoring_enabled=False)
            try:
                async with self.db.begin_nested():
                    self._apply_channel(streamer, ch)
                    self.db.add(streamer)
            except IntegrityError:  # created concurrently by another request
                streamer = await self.db.scalar(select(Streamer).where(*key))
                assert streamer is not None
        self._apply_channel(streamer, ch)
        await self.db.flush()
        return streamer

    @staticmethod
    def _apply_channel(s: Streamer, ch: ChannelInfo) -> None:
        s.username = ch.username
        s.display_name = ch.display_name
        s.profile_image_url = ch.profile_image_url
        if ch.is_live is not None:
            s.is_live = ch.is_live
            s.current_title = ch.current_title
            s.current_category = ch.current_category

    async def _sync_aggregate(self, streamer: Streamer) -> None:
        streamer.monitoring_enabled = bool(
            await self.db.scalar(
                select(
                    exists().where(UserStreamer.streamer_id == streamer.id, UserStreamer.monitoring_enabled.is_(True))
                )
            )
        )
        await self.db.flush()
