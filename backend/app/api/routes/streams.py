from __future__ import annotations

from fastapi import APIRouter

from app.api.dependencies import PageDep, StreamerServiceDep
from app.schemas.common import ERROR_RESPONSES, Page
from app.schemas.streamer import StreamerOut, StreamStatusOut
from app.services.streamer_service import to_status

router = APIRouter(prefix="/api/v1/streams", tags=["streams"], responses=ERROR_RESPONSES)


@router.get("/live", response_model=Page[StreamerOut], summary="Watchlist streamers currently known to be live")
async def live_streams(svc: StreamerServiceDep, page: PageDep) -> Page[StreamerOut]:
    return await svc.list(limit=page.limit, offset=page.offset, live_only=True)


@router.get("/{streamer_id}", response_model=StreamStatusOut, summary="Last known stream details")
async def stream_details(streamer_id: int, svc: StreamerServiceDep) -> StreamStatusOut:
    return to_status((await svc.get_entry(streamer_id)).streamer)


@router.get("/{streamer_id}/status", response_model=StreamStatusOut, summary="Last known live status")
async def stream_status(streamer_id: int, svc: StreamerServiceDep) -> StreamStatusOut:
    # Same data as /{streamer_id} today; kept separate because Phase 4 makes this a fresh check.
    return to_status((await svc.get_entry(streamer_id)).streamer)
