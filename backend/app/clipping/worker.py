"""Requests platform clips and confirms them in the background.

`request(clip_id)`  – POST the clip on the platform (Twitch), store id/edit link, then confirm.
`verify(clip_id)`   – poll until the platform reports the clip (Twitch: up to ~15 s) → created,
                      otherwise failed with a clear reason. Never marks a clip created on faith.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.types import utcnow
from app.domain.enums import ClipStatus as S, Platform
from app.domain.status import transition
from app.errors import AppError, UpstreamError
from app.integrations.http import PlatformAuthError
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.integrations.twitch.clips import create_clip, get_clip
from app.models import Clip, HighlightCandidate, Streamer, User
from app.services.connection_service import ConnectionService
from app.utils.crypto import TokenCipher

log = logging.getLogger("streamhunter.clips")

VERIFY_DELAYS = (3.0, 5.0, 7.0, 10.0)  # ≈25 s in total


def describe_create_error(exc: AppError) -> str:
    if isinstance(exc, PlatformAuthError) or exc.code == "requires_authorization":
        return "Twitch refused: reconnect your Twitch account so StreamHunter may create clips (clips:edit)."
    if isinstance(exc, UpstreamError) and (exc.details or {}).get("platform_status") in (400, 404):
        return "Twitch could not clip this channel: it may be offline, or clips are disabled for it."
    return f"Clip creation failed: {exc.message}"


class ClipWorker:
    def __init__(self, maker: async_sessionmaker[AsyncSession], registry: PlatformRegistry, cipher: TokenCipher,
                 *, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self.maker = maker
        self.registry = registry
        self.cipher = cipher
        self._sleep = sleep
        self._tasks: set[asyncio.Task[None]] = set()

    def spawn(self, coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Wait for background work (tests and shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def stop(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        with contextlib.suppress(Exception):
            await self.drain()

    def _twitch(self) -> TwitchAdapter | None:
        a = self.registry.get(Platform.TWITCH)
        return a if isinstance(a, TwitchAdapter) and a.client_id and a.helix else None

    async def _fail(self, db: AsyncSession, clip: Clip, message: str) -> None:
        clip.status = transition(clip.status, S.FAILED).value
        clip.error_message = message
        await db.commit()
        log.warning("clip_failed", extra={"clip_id": clip.id, "reason": message})

    async def request(self, clip_id: int) -> None:
        """Clip must already be in creation_requested."""
        async with self.maker() as db:
            clip = await db.get(Clip, clip_id)
            if clip is None or clip.status != S.CREATION_REQUESTED.value:
                return
            adapter = self._twitch()
            if adapter is None:
                return await self._fail(db, clip, "Twitch is not configured on the backend.")
            cand = await db.get(HighlightCandidate, clip.candidate_id)
            user = await db.get(User, clip.user_id)
            streamer = await db.get(Streamer, cand.streamer_id) if cand else None
            if cand is None or user is None or streamer is None:
                return await self._fail(db, clip, "The highlight for this clip no longer exists.")
            try:
                token = await ConnectionService(db, self.registry, self.cipher).access_token(user, Platform.TWITCH)
                result = await create_clip(adapter.http, client_id=adapter.client_id, user_token=token,  # type: ignore[arg-type]
                                           broadcaster_id=streamer.platform_user_id)
            except AppError as exc:
                return await self._fail(db, clip, describe_create_error(exc))
            now = utcnow()
            clip.platform_clip_id = result.clip_id
            clip.edit_url = result.edit_url
            clip.requested_at = now
            clip.request_lag_seconds = round((now - cand.timestamp).total_seconds(), 1)
            clip.error_message = None
            await db.commit()
        log.info("clip_requested", extra={"clip_id": clip_id})
        await self.verify(clip_id)

    async def verify(self, clip_id: int) -> None:
        adapter = self._twitch()
        for delay in VERIFY_DELAYS:
            await self._sleep(delay)
            async with self.maker() as db:
                clip = await db.get(Clip, clip_id)
                if clip is None or clip.status != S.CREATION_REQUESTED.value or not clip.platform_clip_id or adapter is None:
                    return
                try:
                    found = await get_clip(adapter.helix, clip.platform_clip_id)  # type: ignore[arg-type]
                except AppError:
                    continue  # transient; keep polling
                if found is None:
                    continue
                clip.status = transition(clip.status, S.CREATED).value
                clip.platform_clip_url = found.url
                clip.duration_seconds = round(found.duration) if found.duration else None
                clip.title = clip.title or found.title
                clip.error_message = None
                await db.commit()
                log.info("clip_created", extra={"clip_id": clip_id})
                return
        async with self.maker() as db:
            clip = await db.get(Clip, clip_id)
            if clip is not None and clip.status == S.CREATION_REQUESTED.value:
                await self._fail(db, clip, "Twitch did not confirm the clip. The channel may have gone offline or "
                                           "clips may be disabled. You can retry while the stream is live.")
