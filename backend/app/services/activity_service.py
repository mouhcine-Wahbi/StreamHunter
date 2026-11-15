"""Read access to monitoring sessions, events, highlights and clips (user-scoped)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.enums import ClipStatus, MonitoringSessionStatus, Platform
from app.errors import NotFoundError
from app.models import Clip, HighlightCandidate, MonitoringSession, StreamEvent, User
from app.schemas.activity import ClipOut, ClipSummary, HighlightOut, MonitoringSessionOut, StreamEventOut
from app.schemas.common import Page
from app.services.vod_service import vod_link_at


async def _page(db: AsyncSession, q: Select, limit: int, offset: int) -> tuple[list, int]:  # type: ignore[type-arg]
    total = await db.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    rows = list((await db.scalars(q.limit(limit).offset(offset))).unique())
    return rows, total


def session_out(s: MonitoringSession) -> MonitoringSessionOut:
    out = MonitoringSessionOut.model_validate(s)
    out.streamer_display_name = s.streamer.display_name
    return out


def highlight_out(h: HighlightCandidate, clip: Clip | None = None) -> HighlightOut:
    out = HighlightOut.model_validate(h)
    out.streamer_display_name = h.streamer.display_name
    out.streamer_username = h.streamer.username
    if h.session is not None:
        out.vod_url_at = vod_link_at(h.session.vod_url, h.start_offset_sec)
    if clip is not None:
        out.clip = ClipSummary.model_validate(clip)
    return out


async def clips_by_candidate(db: AsyncSession, user_id: int, ids: list[int]) -> dict[int, Clip]:
    if not ids:
        return {}
    rows = (await db.scalars(select(Clip).where(Clip.user_id == user_id, Clip.candidate_id.in_(ids)).order_by(Clip.id))).all()
    return {c.candidate_id: c for c in rows}  # latest per candidate


class ActivityService:
    def __init__(self, db: AsyncSession, user: User):
        self.db = db
        self.user = user

    # --- monitoring sessions ---
    async def list_sessions(
        self, *, limit: int, offset: int, status: MonitoringSessionStatus | None = None
    ) -> Page[MonitoringSessionOut]:
        q = select(MonitoringSession).where(MonitoringSession.user_id == self.user.id)
        if status:
            q = q.where(MonitoringSession.status == status.value)
        rows, total = await _page(self.db, q.order_by(MonitoringSession.started_at.desc()), limit, offset)
        return Page(items=[session_out(r) for r in rows], total=total, limit=limit, offset=offset)

    async def get_session(self, session_id: int) -> MonitoringSession:
        s = await self.db.scalar(
            select(MonitoringSession).where(MonitoringSession.id == session_id, MonitoringSession.user_id == self.user.id)
        )
        if s is None:
            raise NotFoundError("Monitoring session not found")
        return s

    async def list_events(self, session_id: int, *, limit: int, offset: int) -> Page[StreamEventOut]:
        await self.get_session(session_id)  # ownership check
        q = select(StreamEvent).where(StreamEvent.session_id == session_id).order_by(StreamEvent.created_at.desc())
        rows, total = await _page(self.db, q, limit, offset)
        return Page(items=[StreamEventOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)

    # --- highlights ---
    async def list_highlights(
        self,
        *,
        limit: int,
        offset: int,
        platform: Platform | None = None,
        streamer_id: int | None = None,
        category: str | None = None,
        min_score: float | None = None,
        status: ClipStatus | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> Page[HighlightOut]:
        h = HighlightCandidate
        q = select(h).where(h.user_id == self.user.id)
        if platform:
            q = q.where(h.platform == platform.value)
        if streamer_id is not None:
            q = q.where(h.streamer_id == streamer_id)
        if category:
            q = q.where(h.category == category)
        if min_score is not None:
            q = q.where(h.score >= min_score)
        if status:
            q = q.where(h.status == status.value)
        if date_from:
            q = q.where(h.timestamp >= date_from)
        if date_to:
            q = q.where(h.timestamp <= date_to)
        rows, total = await _page(self.db, q.order_by(h.timestamp.desc()), limit, offset)
        clips = await clips_by_candidate(self.db, self.user.id, [r.id for r in rows])
        return Page(items=[highlight_out(r, clips.get(r.id)) for r in rows], total=total, limit=limit, offset=offset)

    async def get_highlight(self, highlight_id: int) -> HighlightOut:
        h = await self.db.scalar(
            select(HighlightCandidate).where(
                HighlightCandidate.id == highlight_id, HighlightCandidate.user_id == self.user.id
            )
        )
        if h is None:
            raise NotFoundError("Highlight not found")
        clips = await clips_by_candidate(self.db, self.user.id, [h.id])
        return highlight_out(h, clips.get(h.id))

    # --- clips ---
    async def list_clips(
        self, *, limit: int, offset: int, status: ClipStatus | None = None, platform: Platform | None = None
    ) -> Page[ClipOut]:
        q = select(Clip).where(Clip.user_id == self.user.id)
        if status:
            q = q.where(Clip.status == status.value)
        if platform:
            q = q.where(Clip.platform == platform.value)
        rows, total = await _page(self.db, q.order_by(Clip.created_at.desc()), limit, offset)
        return Page(items=[ClipOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset)

    async def get_clip(self, clip_id: int) -> ClipOut:
        c = await self.db.scalar(select(Clip).where(Clip.id == clip_id, Clip.user_id == self.user.id))
        if c is None:
            raise NotFoundError("Clip not found")
        return ClipOut.model_validate(c)
