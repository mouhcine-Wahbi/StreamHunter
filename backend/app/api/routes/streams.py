from __future__ import annotations

from fastapi import APIRouter

from app.errors import PlatformUnavailableError
from app.api.dependencies import CurrentUser, PageDep, StreamerServiceDep, StreamStatusServiceDep
from app.schemas.common import ERROR_RESPONSES, Page
from app.schemas.platform import RefreshOut
from app.schemas.streamer import StreamerOut, StreamStatusOut
from app.services.streamer_service import to_status

router = APIRouter(prefix="/api/v1/streams", tags=["streams"], responses=ERROR_RESPONSES)


@router.get("/live", response_model=Page[StreamerOut], summary="Watchlist streamers currently known to be live")
async def live_streams(svc: StreamerServiceDep, page: PageDep) -> Page[StreamerOut]:
    return await svc.list(limit=page.limit, offset=page.offset, live_only=True)


@router.post(
    "/refresh",
    response_model=RefreshOut,
    summary="Check live status of your whole watchlist now (batched; skips streamers checked < 30 s ago)",
)
async def refresh_watchlist(user: CurrentUser, status_svc: StreamStatusServiceDep) -> RefreshOut:
    s = await status_svc.refresh_watchlist(user)
    return RefreshOut(checked=s.checked, live=s.live, skipped_recent=s.skipped_recent, unavailable=s.unavailable)


@router.get("/{streamer_id}", response_model=StreamStatusOut, summary="Last known stream details (no platform call)")
async def stream_details(streamer_id: int, svc: StreamerServiceDep) -> StreamStatusOut:
    return to_status((await svc.get_entry(streamer_id)).streamer)


@router.get("/{streamer_id}/status", response_model=StreamStatusOut, summary="Fresh live status from the platform")
async def stream_status(streamer_id: int, svc: StreamerServiceDep, status_svc: StreamStatusServiceDep) -> StreamStatusOut:
    streamer = (await svc.get_entry(streamer_id)).streamer
    summary = await status_svc.refresh_streamers([streamer])
    if streamer.platform in summary.unavailable:
        raise PlatformUnavailableError(summary.unavailable[streamer.platform], code="status_unavailable")
    return to_status(streamer)
