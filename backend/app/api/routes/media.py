"""Authorized media: user-provided recordings, analysis jobs. Never downloads from platforms."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, Request, Response, UploadFile, status
from sqlalchemy import func, select

from app.api.dependencies import CurrentUser, DbDep, PageDep
from app.clipping.jobs import MediaJobRunner
from app.clipping.media_access import ALLOWED_EXTENSIONS, MediaLibrary
from app.errors import AppError, NotFoundError
from app.models import MediaJob, MediaSource, MonitoringSession, User
from app.schemas.common import ERROR_RESPONSES, Page
from app.schemas.media import MediaCapabilitiesOut, MediaJobOut, MediaPatch, MediaRegister, MediaSourceOut

router = APIRouter(prefix="/api/v1/media", tags=["media"], responses=ERROR_RESPONSES)
CHUNK = 1024 * 1024


def _lib(request: Request) -> MediaLibrary:
    return request.app.state.media_library  # type: ignore[no-any-return]


def _jobs(request: Request) -> MediaJobRunner:
    return request.app.state.media_jobs  # type: ignore[no-any-return]


async def _own_session(db: DbDep, user: User, session_id: int | None) -> None:
    if session_id is None:
        return
    s = await db.get(MonitoringSession, session_id)
    if s is None or s.user_id != user.id:
        raise NotFoundError("Monitoring session not found")


async def _own_media(db: DbDep, user: User, media_id: int) -> MediaSource:
    m = await db.get(MediaSource, media_id)
    if m is None or m.user_id != user.id:
        raise NotFoundError("Recording not found")
    return m


async def _probe_into(lib: MediaLibrary, m: MediaSource, path: Path) -> None:
    lib.require_tools()
    p = await lib.probe(path)
    m.duration_sec, m.has_audio, m.has_video, m.width, m.height = p.duration_sec, p.has_audio, p.has_video, p.width, p.height
    m.size_bytes = path.stat().st_size


def _subtitles_capability(request: Request, lib: MediaLibrary) -> str:
    transcriber = _jobs(request).transcriber
    return "supported" if lib.available and transcriber is not None and transcriber.available else "requires_configuration"


@router.get("/capabilities", response_model=MediaCapabilitiesOut, summary="What media processing this backend can do")
async def capabilities(request: Request, user: CurrentUser) -> MediaCapabilitiesOut:
    lib = _lib(request)
    tools = "supported" if lib.available else "requires_configuration"
    return MediaCapabilitiesOut(
        ffmpeg_available=lib.available,
        max_upload_mb=request.app.state.settings.max_upload_mb,
        media_folder=str(lib.library_dir(user.id)),
        supported_extensions=sorted(ALLOWED_EXTENSIONS),
        audio_analysis=tools,
        visual_analysis=tools,
        export=tools,
        subtitles=_subtitles_capability(request, lib),
        live_tab_audio="supported",  # the extension measures; POST /api/v1/monitoring/audio receives loudness
        platform_vod_download="unsupported",  # by design: only user-provided recordings
    )


@router.post("/upload", response_model=MediaSourceOut, status_code=status.HTTP_201_CREATED, summary="Upload a recording you own")
async def upload(
    request: Request,
    db: DbDep,
    user: CurrentUser,
    file: Annotated[UploadFile, File(description="Video or audio recording")],
    rights_confirmed: Annotated[bool, Form()] = False,
    session_id: Annotated[int | None, Form()] = None,
    offset_in_stream_sec: Annotated[float, Form(ge=0)] = 0.0,
) -> MediaSourceOut:
    if not rights_confirmed:
        raise AppError("Confirm that you have the rights to process this recording", code="rights_not_confirmed")
    await _own_session(db, user, session_id)
    lib = _lib(request)
    name = lib.safe_filename(file.filename or "recording.mp4")
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise AppError(f"Unsupported file type; use one of {', '.join(sorted(ALLOWED_EXTENSIONS))}", code="invalid_media_type")
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    rel = f"{stamp}_{name}"
    dest = lib.library_dir(user.id) / rel
    limit = request.app.state.settings.max_upload_mb * CHUNK
    written = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > limit:
                    raise AppError(f"File is larger than {request.app.state.settings.max_upload_mb} MB", code="file_too_large")
                out.write(chunk)
        m = MediaSource(user_id=user.id, session_id=session_id, kind="upload", relative_path=rel, original_name=name[:255],
                        offset_in_stream_sec=offset_in_stream_sec, rights_confirmed_at=datetime.now(UTC), status="ready")
        await _probe_into(lib, m, dest)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    db.add(m)
    await db.flush()
    return MediaSourceOut.model_validate(m)


@router.post("/register", response_model=MediaSourceOut, status_code=status.HTTP_201_CREATED,
             summary="Use a file already in your media folder (large recordings)")
async def register(body: MediaRegister, request: Request, db: DbDep, user: CurrentUser) -> MediaSourceOut:
    await _own_session(db, user, body.session_id)
    lib = _lib(request)
    path = lib.resolve(user.id, body.relative_path)
    m = MediaSource(user_id=user.id, session_id=body.session_id, kind="registered",
                    relative_path=str(path.relative_to(lib.library_dir(user.id).resolve())), original_name=path.name[:255],
                    offset_in_stream_sec=body.offset_in_stream_sec, rights_confirmed_at=datetime.now(UTC), status="ready")
    await _probe_into(lib, m, path)
    db.add(m)
    await db.flush()
    return MediaSourceOut.model_validate(m)


@router.get("", response_model=Page[MediaSourceOut], summary="Your recordings")
async def list_media(db: DbDep, user: CurrentUser, page: PageDep, session_id: int | None = None) -> Page[MediaSourceOut]:
    q = select(MediaSource).where(MediaSource.user_id == user.id)
    if session_id is not None:
        q = q.where(MediaSource.session_id == session_id)
    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = (await db.scalars(q.order_by(MediaSource.id.desc()).limit(page.limit).offset(page.offset))).all()
    return Page(items=[MediaSourceOut.model_validate(r) for r in rows], total=total, limit=page.limit, offset=page.offset)


@router.patch("/{media_id}", response_model=MediaSourceOut, summary="Attach to a session / set the start offset")
async def patch_media(media_id: int, body: MediaPatch, db: DbDep, user: CurrentUser) -> MediaSourceOut:
    m = await _own_media(db, user, media_id)
    if "session_id" in body.model_fields_set:
        await _own_session(db, user, body.session_id)
        m.session_id = body.session_id
    if body.offset_in_stream_sec is not None:
        m.offset_in_stream_sec = body.offset_in_stream_sec
    await db.flush()
    return MediaSourceOut.model_validate(m)


@router.delete("/{media_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response,
               summary="Forget a recording (uploaded files are deleted; registered files are left alone)")
async def delete_media(media_id: int, request: Request, db: DbDep, user: CurrentUser) -> None:
    m = await _own_media(db, user, media_id)
    if m.kind == "upload":
        try:
            _lib(request).resolve(user.id, m.relative_path).unlink(missing_ok=True)
        except AppError:
            pass
    await db.delete(m)


@router.post("/{media_id}/analyze", response_model=MediaJobOut, status_code=status.HTTP_202_ACCEPTED,
             summary="Post-stream analysis: audio peaks, scene changes, candidate enrichment and merging")
async def analyze(media_id: int, request: Request, db: DbDep, user: CurrentUser) -> MediaJobOut:
    m = await _own_media(db, user, media_id)
    _lib(request).require_tools()
    if m.session_id is None:
        raise AppError("Attach the recording to a monitoring session first", code="media_not_attached")
    job = MediaJob(user_id=user.id, kind="analyze", media_source_id=m.id, status="queued", result={})
    db.add(job)
    await db.commit()
    _jobs(request).submit(job.id)
    return MediaJobOut.model_validate(job)


@router.get("/jobs/{job_id}", response_model=MediaJobOut, summary="Media job status")
async def get_job(job_id: int, db: DbDep, user: CurrentUser) -> MediaJobOut:
    job = await db.get(MediaJob, job_id)
    if job is None or job.user_id != user.id:
        raise NotFoundError("Job not found")
    await db.refresh(job)
    return MediaJobOut.model_validate(job)
