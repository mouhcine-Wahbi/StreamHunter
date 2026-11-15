"""Highlight review: list, inspect, approve, reject, reopen/adjust."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.dependencies import ActivityServiceDep, CurrentUser, DbDep, PageDep
from app.domain.enums import ClipStatus, Platform
from app.schemas.activity import ClipOut, HighlightOut, HighlightPatch, ReviewOut
from app.schemas.common import ERROR_RESPONSES, Page
from app.services.activity_service import highlight_out
from app.services.clip_service import ClipService

router = APIRouter(prefix="/api/v1/highlights", tags=["highlights"], responses=ERROR_RESPONSES)


def clip_service(db: DbDep, user: CurrentUser) -> ClipService:
    return ClipService(db, user)


ClipServiceDep = Annotated[ClipService, Depends(clip_service)]


@router.get("", response_model=Page[HighlightOut], summary="Highlight candidates")
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
        limit=page.limit, offset=page.offset, platform=platform, streamer_id=streamer_id, category=category,
        min_score=min_score, status=status, date_from=date_from, date_to=date_to,
    )


@router.get("/{highlight_id}", response_model=HighlightOut, summary="One highlight candidate")
async def get_highlight(highlight_id: int, svc: ActivityServiceDep) -> HighlightOut:
    return await svc.get_highlight(highlight_id)


@router.post("/{highlight_id}/approve", response_model=ReviewOut, summary="Approve; prepares its clip")
async def approve(highlight_id: int, svc: ClipServiceDep) -> ReviewOut:
    cand, clip = await svc.approve(highlight_id)
    return ReviewOut(highlight=highlight_out(cand, clip), clip=ClipOut.model_validate(clip))


@router.post("/{highlight_id}/reject", response_model=ReviewOut, summary="Reject (can be reopened)")
async def reject(highlight_id: int, svc: ClipServiceDep) -> ReviewOut:
    cand = await svc.reject(highlight_id)
    clip = await svc.clip_for(cand.id)
    return ReviewOut(highlight=highlight_out(cand, clip), clip=ClipOut.model_validate(clip) if clip else None)


@router.patch("/{highlight_id}", response_model=HighlightOut, summary="Reopen, adjust window or category")
async def update_highlight(highlight_id: int, body: HighlightPatch, svc: ClipServiceDep) -> HighlightOut:
    cand = await svc.update_candidate(
        highlight_id,
        reopen=body.status == "pending_review",
        start=body.start_offset_sec,
        end=body.end_offset_sec,
        category=body.category.value if body.category else None,
        fields=body.model_fields_set,
    )
    return highlight_out(cand, await svc.clip_for(cand.id))
