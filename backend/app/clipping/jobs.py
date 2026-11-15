"""Background media jobs (analyze a recording, export a clip) with bounded concurrency."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clipping import ffmpeg_processor as ff
from app.clipping.media_access import MediaLibrary
from app.clipping.vod_analysis import analyze_recording
from app.config import Settings
from app.db.types import utcnow
from app.domain.enums import ClipStatus as S
from app.domain.status import transition
from app.errors import AppError
from app.models import Clip, HighlightCandidate, MediaJob, MediaSource, User
from app.services.settings_service import SettingsService

log = logging.getLogger("streamhunter.media")


def export_window(cand: HighlightCandidate, media: MediaSource) -> tuple[float, float]:
    """(file start, duration) of the candidate window in the recording, or an explicit error."""
    if cand.start_offset_sec is None or cand.end_offset_sec is None:
        raise AppError("This highlight has no stream offsets, so it can't be located in a recording", code="no_offsets")
    start = cand.start_offset_sec - media.offset_in_stream_sec
    end = cand.end_offset_sec - media.offset_in_stream_sec
    dur = media.duration_sec or 0
    if end <= 0 or (dur and start >= dur):
        raise AppError("The attached recording does not cover this moment (check its start offset)", code="outside_recording")
    start = max(0.0, start)
    end = min(end, dur) if dur else end
    return start, end - start


class MediaJobRunner:
    def __init__(self, maker: async_sessionmaker[AsyncSession], library: MediaLibrary, settings: Settings):
        self.maker = maker
        self.library = library
        self.settings = settings
        self._sem = asyncio.Semaphore(settings.max_concurrent_media_jobs)
        self._tasks: set[asyncio.Task[None]] = set()

    def submit(self, job_id: int) -> None:
        task = asyncio.ensure_future(self._run(job_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def stop(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        with contextlib.suppress(Exception):
            await self.drain()

    async def _run(self, job_id: int) -> None:
        async with self._sem, self.maker() as db:
            job = await db.get(MediaJob, job_id)
            if job is None or job.status != "queued":
                return
            job.status, job.started_at = "running", utcnow()
            await db.commit()
            try:
                result = await (self._analyze(db, job) if job.kind == "analyze" else self._export(db, job))
                job.status, job.result = "succeeded", {**(job.result or {}), **result}
                job.error_message = None
            except Exception as exc:  # noqa: BLE001 - every failure must be recorded on the job
                await db.rollback()
                job = await db.get(MediaJob, job_id)
                assert job is not None
                job.status = "failed"
                job.error_message = exc.message if isinstance(exc, AppError) else "Unexpected processing error"
                if not isinstance(exc, AppError):
                    log.exception("media_job_crashed", extra={"job_id": job_id})
                await self._revert_clip(db, job)
            job.finished_at = utcnow()
            await db.commit()
            log.info("media_job_finished", extra={"job_id": job_id, "kind": job.kind, "status": job.status})

    async def _media(self, db: AsyncSession, job: MediaJob) -> tuple[MediaSource, Any]:
        media = await db.get(MediaSource, job.media_source_id)
        if media is None or media.user_id != job.user_id:
            raise AppError("Recording not found", code="not_found")
        self.library.require_tools()
        return media, self.library.resolve(job.user_id, media.relative_path)

    async def _analyze(self, db: AsyncSession, job: MediaJob) -> dict[str, Any]:
        media, path = await self._media(db, job)
        user = await db.get(User, job.user_id)
        settings = await SettingsService(db, user).get()  # type: ignore[arg-type]
        return await analyze_recording(db, media, path, ffmpeg=self.library.ffmpeg,
                                       timeout=self.settings.media_job_timeout_seconds, settings=settings)

    async def _export(self, db: AsyncSession, job: MediaJob) -> dict[str, Any]:
        media, path = await self._media(db, job)
        clip = await db.get(Clip, job.clip_id) if job.clip_id else None
        if clip is None or clip.user_id != job.user_id:
            raise AppError("Clip not found", code="not_found")
        cand = await db.get(HighlightCandidate, clip.candidate_id)
        assert cand is not None
        start, duration = export_window(cand, media)
        aspect = clip.aspect_ratio or "9:16"
        name = f"clip_{clip.id}_{aspect.replace(':', 'x')}.mp4"
        dst = self.library.resolve_export(job.user_id, name)
        await ff.export_clip(self.library.ffmpeg, path, dst, start=start, duration=duration, aspect=aspect,
                             has_video=media.has_video, has_audio=media.has_audio,
                             timeout=self.settings.media_job_timeout_seconds)
        clip.local_file_path = name
        clip.status = transition(clip.status, S.READY).value
        clip.error_message = None
        return {"file": name, "start_sec": round(start, 2), "duration_sec": round(duration, 2), "aspect_ratio": aspect,
                "size_bytes": dst.stat().st_size}

    async def _revert_clip(self, db: AsyncSession, job: MediaJob) -> None:
        if job.kind != "export" or not job.clip_id:
            return
        clip = await db.get(Clip, job.clip_id)
        prev = (job.result or {}).get("previous_status")
        if clip is not None and clip.status == S.EXPORTING.value and prev:
            clip.status = transition(clip.status, prev).value
            clip.error_message = f"Export failed: {job.error_message}"


async def latest_media_for_session(db: AsyncSession, user_id: int, session_id: int) -> MediaSource | None:
    return await db.scalar(
        select(MediaSource)
        .where(MediaSource.user_id == user_id, MediaSource.session_id == session_id, MediaSource.status == "ready")
        .order_by(MediaSource.id.desc())
    )
