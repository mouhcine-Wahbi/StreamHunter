"""Twitch clip creation (Helix `POST /clips`) and confirmation (`GET /clips`).

Facts that shape the workflow:
  * Create Clip needs a *user* token with `clips:edit` and only works while the channel is live.
  * The clip is cut from the broadcast at the time of the request, not from an earlier moment,
    so StreamHunter requests it as soon as a highlight is detected.
  * The call is asynchronous: it returns an id + edit_url. The clip exists only once
    `GET /clips?id=` returns it (Twitch documents up to ~15 s).
  * A clip is a page on Twitch (`url`); there is no downloadable media file.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from app.errors import UpstreamError
from app.integrations.http import RequestSpec, json_body, send
from app.integrations.twitch.client import HELIX_URL, HelixClient


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CreatedClip(_M):
    id: str
    edit_url: str | None = None


class HelixClip(_M):
    id: str
    url: str
    title: str | None = None
    duration: float | None = None
    thumbnail_url: str | None = None


@dataclass(frozen=True, slots=True)
class ClipRequestResult:
    clip_id: str
    edit_url: str | None


async def create_clip(http: httpx.AsyncClient, *, client_id: str, user_token: str, broadcaster_id: str) -> ClipRequestResult:
    resp = await send(
        http,
        RequestSpec(
            "twitch",
            "POST",
            f"{HELIX_URL}/clips",
            params={"broadcaster_id": broadcaster_id, "has_delay": "false"},
            headers={"Authorization": f"Bearer {user_token}", "Client-Id": client_id},
        ),
        retries=0,  # never create duplicate clips by retrying blindly
    )
    try:
        data = (json_body(resp, "twitch") or {}).get("data") or []
        c = CreatedClip.model_validate(data[0])
    except (ValidationError, IndexError, AttributeError) as exc:
        raise UpstreamError("Twitch returned an unexpected Create Clip response") from exc
    return ClipRequestResult(clip_id=c.id, edit_url=c.edit_url)


async def get_clip(helix: HelixClient, clip_id: str) -> HelixClip | None:
    """The clip once Twitch has finished processing it; None while it doesn't exist yet."""
    body = await helix._get("/clips", [("id", clip_id)])  # app token is enough to read clips
    items = HelixClient._parse(HelixClip, body)
    return items[0] if items else None
