"""Read endpoints for monitoring sessions, highlights and clips.

Write operations (heartbeat/lease, approve/reject, clip creation) arrive with their
phases (4, 5, 6) and are deliberately absent here rather than stubbed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.dependencies import ActivityServiceDep, PageDep
from app.domain.enums import ClipStatus, MonitoringSessionStatus, Platform
from app.schemas.activity import ClipOut, HighlightOut, MonitoringSessionOut, StreamEventOut
from app.schemas.common import ERROR_RESPONSES, Page
from app.services.activity_service import session_out

monitoring = APIRouter(prefix="/api/v1/monitoring", tags=["monitoring"], responses=ERROR_RESPONSES)
highlights = APIRouter(prefix="/api/v1/highlights", tags=["highlights"], responses=ERROR_RESPONSES)
clips = APIRouter(prefix="/api/v1/clips", tags=["clips"], responses=ERROR_RESPONSES)


@monitoring.get("", response_model=Page[MonitoringSessionOut], summary="Monitoring session history")
async def list_sessions(
    svc: ActivityServiceDep, page: PageDep, status: MonitoringSessionStatus | None = None
) -> Page[MonitoringSessionOut]:
    return await svc.list_sessions(limit=page.limit, offset=page.offset, status=status)


@monitoring.get("/{session_id}", response_model=MonitoringSessionOut, summary="One monitoring session")
async def get_session(session_id: int, svc: ActivityServiceDep) -> MonitoringSessionOut:
    return session_out(await svc.get_session(session_id))


@monitoring.get("/{session_id}/events", response_model=Page[StreamEventOut], summary="Detection events of a session")
async def list_events(session_id: int, svc: ActivityServiceDep, page: PageDep) -> Page[StreamEventOut]:
    return await svc.list_events(session_id, limit=page.limit, offset=page.offset)


@highlights.get("", response_model=Page[HighlightOut], summary="Highlight candidates")
async def list_highlights(
    svc: ActivityServiceDep,
    page: PageDep,
    platform: Platform | None = None,
    streamer_id: int | None = None,
    category: Annotated[str | None, Query(max_length=48)] = None,
    min_score: Annotated[float | None, Query(ge=0, le=100)] = None,
    status: ClipStatus | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> Page[HighlightOut]:
    return await svc.list_highlights(
        limit=page.limit,
        offset=page.offset,
        platform=platform,
        streamer_id=streamer_id,
        category=category,
        min_score=min_score,
        status=status,
        date_from=date_from,
        date_to=date_to,
    )


@highlights.get("/{highlight_id}", response_model=HighlightOut, summary="One highlight candidate")
async def get_highlight(highlight_id: int, svc: ActivityServiceDep) -> HighlightOut:
    return await svc.get_highlight(highlight_id)


@clips.get("", response_model=Page[ClipOut], summary="Clip library")
async def list_clips(
    svc: ActivityServiceDep, page: PageDep, status: ClipStatus | None = None, platform: Platform | None = None
) -> Page[ClipOut]:
    return await svc.list_clips(limit=page.limit, offset=page.offset, status=status, platform=platform)


@clips.get("/{clip_id}", response_model=ClipOut, summary="One clip")
async def get_clip(clip_id: int, svc: ActivityServiceDep) -> ClipOut:
    return await svc.get_clip(clip_id)
