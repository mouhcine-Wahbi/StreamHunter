"""Clip library and clip actions. Nothing is ever published without explicit confirmation."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.api.dependencies import ActivityServiceDep, CurrentUser, DbDep, PageDep
from app.clipping.worker import ClipWorker
from app.domain.enums import ClipStatus, Platform
from app.schemas.activity import ClipCreateRequest, ClipOut, ClipPatch, PublishRequest
from app.schemas.common import ERROR_RESPONSES, Page
from app.services.clip_service import ClipService

router = APIRouter(prefix="/api/v1/clips", tags=["clips"], responses=ERROR_RESPONSES)


def clip_service(db: DbDep, user: CurrentUser) -> ClipService:
    return ClipService(db, user)


ClipServiceDep = Annotated[ClipService, Depends(clip_service)]


def _worker(request: Request) -> ClipWorker:
    return request.app.state.clip_worker  # type: ignore[no-any-return]


@router.get("", response_model=Page[ClipOut], summary="Clip library")
async def list_clips(
    svc: ActivityServiceDep, page: PageDep, status: ClipStatus | None = None, platform: Platform | None = None
) -> Page[ClipOut]:
    return await svc.list_clips(limit=page.limit, offset=page.offset, status=status, platform=platform)


@router.get("/{clip_id}", response_model=ClipOut, summary="One clip")
async def get_clip(clip_id: int, svc: ActivityServiceDep) -> ClipOut:
    return await svc.get_clip(clip_id)


async def _request(clip_id: int, body: ClipCreateRequest, request: Request, svc: ClipService, db: DbDep) -> ClipOut:
    clip = await svc.prepare_request(clip_id, accept_current_moment=body.accept_current_moment)
    await db.commit()  # the worker uses its own session
    await _worker(request).request(clip.id)  # POST now; confirmation continues in the background
    await db.refresh(clip)
    return ClipOut.model_validate(clip)


@router.post("/{clip_id}/create", response_model=ClipOut, summary="Request the official platform clip (Twitch)")
async def create(clip_id: int, body: ClipCreateRequest, request: Request, svc: ClipServiceDep, db: DbDep) -> ClipOut:
    return await _request(clip_id, body, request, svc, db)


@router.post("/{clip_id}/retry", response_model=ClipOut, summary="Retry a failed clip request")
async def retry(clip_id: int, body: ClipCreateRequest, request: Request, svc: ClipServiceDep, db: DbDep) -> ClipOut:
    return await _request(clip_id, body, request, svc, db)


@router.post("/{clip_id}/export", response_model=ClipOut, summary="Export the media file (needs an authorized media source)")
async def export(clip_id: int, svc: ClipServiceDep) -> ClipOut:
    await svc.export(clip_id)
    raise AssertionError("unreachable")


@router.patch("/{clip_id}", response_model=ClipOut, summary="Title, aspect ratio, or manual clip URL")
async def update_clip(clip_id: int, body: ClipPatch, svc: ClipServiceDep) -> ClipOut:
    clip = await svc.update_clip(
        clip_id, fields=body.model_fields_set, title=body.title, aspect_ratio=body.aspect_ratio,
        platform_clip_url=body.platform_clip_url,
    )
    return ClipOut.model_validate(clip)


@router.post("/{clip_id}/publish", response_model=ClipOut, summary="Mark as published (requires confirm: true)")
async def publish(clip_id: int, body: PublishRequest, svc: ClipServiceDep, user: CurrentUser) -> ClipOut:
    clip = await svc.publish(clip_id, published_url=str(body.published_url) if body.published_url else None)
    return ClipOut.model_validate(clip)
