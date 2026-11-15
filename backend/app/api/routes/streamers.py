from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.dependencies import CurrentUser, PageDep, RegistryDep, StreamerServiceDep
from app.domain.enums import Platform
from app.schemas.common import ERROR_RESPONSES, Page
from app.services.streamer_service import to_out
from app.schemas.streamer import USERNAME_PATTERN, StreamerCreate, StreamerOut, StreamerSearchResult, StreamerUpdate

router = APIRouter(prefix="/api/v1/streamers", tags=["streamers"], responses=ERROR_RESPONSES)


@router.get(
    "/search",
    response_model=list[StreamerSearchResult],
    summary="Search channels on a platform",
    responses={501: {"description": "Platform integration not available yet"}, 503: {"description": "Platform not configured"}},
)
async def search(
    _user: CurrentUser,
    registry: RegistryDep,
    platform: Platform,
    username: Annotated[str, Query(pattern=USERNAME_PATTERN)],
    limit: Annotated[int, Query(ge=1, le=25)] = 10,
) -> list[StreamerSearchResult]:
    results = await registry.get(platform).search_channels(username, limit=limit)
    return [
        StreamerSearchResult(
            platform=r.platform,
            platform_user_id=r.platform_user_id,
            username=r.username,
            display_name=r.display_name,
            profile_image_url=r.profile_image_url,
            is_live=r.is_live,
            current_title=r.current_title,
            current_category=r.current_category,
        )
        for r in results
    ]


@router.get("", response_model=Page[StreamerOut], summary="Your watchlist")
async def list_streamers(svc: StreamerServiceDep, page: PageDep) -> Page[StreamerOut]:
    return await svc.list(limit=page.limit, offset=page.offset)


@router.post(
    "",
    response_model=StreamerOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add a channel to your watchlist (resolved through the platform API)",
)
async def add_streamer(body: StreamerCreate, svc: StreamerServiceDep, registry: RegistryDep) -> StreamerOut:
    return await svc.add(body, registry.get(body.platform))


@router.get("/{streamer_id}", response_model=StreamerOut, summary="One watchlist entry")
async def get_streamer(streamer_id: int, svc: StreamerServiceDep) -> StreamerOut:
    return to_out(await svc.get_entry(streamer_id))


@router.patch("/{streamer_id}", response_model=StreamerOut, summary="Toggle monitoring / favorite")
async def update_streamer(streamer_id: int, body: StreamerUpdate, svc: StreamerServiceDep) -> StreamerOut:
    return await svc.update(streamer_id, body)


@router.delete("/{streamer_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response, summary="Remove from your watchlist")
async def delete_streamer(streamer_id: int, svc: StreamerServiceDep) -> None:
    await svc.remove(streamer_id)
