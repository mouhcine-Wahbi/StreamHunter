"""Browser-based monitoring: lease (heartbeat/start/stop), status, session history."""

from __future__ import annotations

import base64
import binascii
from datetime import timedelta

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import func, select

from app.api.dependencies import ActivityServiceDep, CurrentUser, DbDep, PageDep
from app.db.types import utcnow
from app.clipping.ffmpeg_processor import MediaProcessingError
from app.errors import AppError, NotFoundError
from app.domain.enums import MonitoringSessionStatus
from app.models import HighlightCandidate, MonitoringLease, MonitoringSession, Streamer, UserStreamer
from app.monitoring.engine import MonitoringEngine
from app.schemas.activity import (
    HeartbeatOut,
    HeartbeatRequest,
    LiveAudioIn,
    LiveAudioOut,
    MonitoringSessionOut,
    MonitoringStatusOut,
    NotificationOut,
    StreamEventOut,
)
from app.schemas.common import ERROR_RESPONSES, Page
from app.services.activity_service import session_out
from app.services.vod_service import lookup_vod

router = APIRouter(prefix="/api/v1/monitoring", tags=["monitoring"], responses=ERROR_RESPONSES)

_EVENT_TYPES = {"stream_online": "streamer_live", "stream_offline": "streamer_offline"}


def _engine(request: Request) -> MonitoringEngine:
    return request.app.state.monitoring  # type: ignore[no-any-return]


async def _beat(request: Request, body: HeartbeatRequest, user: CurrentUser, db: DbDep) -> HeartbeatOut:
    engine = _engine(request)
    result = await engine.heartbeat(db, user, client=body.client, interval_seconds=body.interval_seconds)
    await db.commit()  # the cycle below runs in its own DB session and must see the lease
    if result.started:
        # Monitoring just (re)started: check this user's streamers right away.
        await engine.run_cycle(only_users={user.id})

    since = body.since or (utcnow() - timedelta(minutes=10))
    events = await engine.recent_events(db, user, since, tuple(_EVENT_TYPES))
    highlights = (
        await db.execute(
            select(HighlightCandidate, Streamer)
            .join(Streamer, Streamer.id == HighlightCandidate.streamer_id)
            .where(HighlightCandidate.user_id == user.id, HighlightCandidate.created_at > since)
            .order_by(HighlightCandidate.created_at)
            .limit(20)
        )
    ).all()
    active = await db.scalar(
        select(func.count()).select_from(MonitoringSession).where(
            MonitoringSession.user_id == user.id, MonitoringSession.status == MonitoringSessionStatus.ACTIVE.value
        )
    )
    live = await db.scalar(
        select(func.count()).select_from(UserStreamer).join(Streamer, Streamer.id == UserStreamer.streamer_id)
        .where(UserStreamer.user_id == user.id, Streamer.is_live.is_(True))
    )
    return HeartbeatOut(
        lease_expires_at=result.lease.expires_at,
        interval_seconds=result.lease.interval_seconds,
        started=result.started,
        active_sessions=active or 0,
        live_count=live or 0,
        notifications=[
            NotificationOut(
                type=_EVENT_TYPES[e.event_type],
                streamer_id=s.id,
                streamer_display_name=s.display_name,
                platform=s.platform,
                title=(e.event_metadata or {}).get("title"),
                category=(e.event_metadata or {}).get("category"),
                at=e.created_at,
            )
            for e, s in events
        ]
        + [
            NotificationOut(
                type="highlight_detected",
                streamer_id=s.id,
                streamer_display_name=s.display_name,
                platform=s.platform,
                title=h.reasons[0] if h.reasons else None,
                category=h.category,
                at=h.created_at,
                highlight_id=h.id,
                score=h.score,
            )
            for h, s in highlights
        ],
        server_time=utcnow(),
    )


@router.post("/heartbeat", response_model=HeartbeatOut, summary="Keep (or start) the browser monitoring lease")
async def heartbeat(request: Request, body: HeartbeatRequest, user: CurrentUser, db: DbDep) -> HeartbeatOut:
    return await _beat(request, body, user, db)


@router.post("/start", response_model=HeartbeatOut, summary="Start monitoring (same as a first heartbeat)")
async def start(request: Request, body: HeartbeatRequest, user: CurrentUser, db: DbDep) -> HeartbeatOut:
    return await _beat(request, body, user, db)


@router.post(
    "/stop", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response,
    summary="Release the lease now; active sessions are paused",
)
async def stop(request: Request, user: CurrentUser, db: DbDep) -> None:
    engine = _engine(request)
    await engine.release(db, user)
    await db.commit()
    await engine.run_cycle()  # pause this user's sessions immediately


@router.get("/status", response_model=MonitoringStatusOut, summary="Lease and scheduler state")
async def monitoring_status(request: Request, user: CurrentUser, db: DbDep) -> MonitoringStatusOut:
    engine = _engine(request)
    lease = await db.scalar(select(MonitoringLease).where(MonitoringLease.user_id == user.id))
    counts = dict(
        (await db.execute(
            select(MonitoringSession.status, func.count()).where(MonitoringSession.user_id == user.id).group_by(MonitoringSession.status)
        )).all()
    )
    return MonitoringStatusOut(
        lease_active=bool(lease and lease.is_active(utcnow())),
        lease_expires_at=lease.expires_at if lease else None,
        last_heartbeat_at=lease.last_heartbeat_at if lease else None,
        active_sessions=counts.get(MonitoringSessionStatus.ACTIVE.value, 0),
        paused_sessions=counts.get(MonitoringSessionStatus.PAUSED.value, 0),
        scheduler_running=bool(getattr(request.app.state, "scheduler", None)),
        last_cycle_at=engine.last_cycle_at,
    )


@router.post("/audio", response_model=LiveAudioOut, summary="Live tab loudness for a monitored channel (numbers only)")
async def live_audio(body: LiveAudioIn, request: Request, user: CurrentUser, db: DbDep) -> LiveAudioOut:
    session = await db.scalar(
        select(MonitoringSession)
        .join(Streamer, Streamer.id == MonitoringSession.streamer_id)
        .where(
            MonitoringSession.user_id == user.id,
            MonitoringSession.status == MonitoringSessionStatus.ACTIVE.value,
            Streamer.platform == body.platform.value,
            func.lower(Streamer.username) == body.channel.lower(),
        )
        .order_by(MonitoringSession.id.desc())
    )
    if session is None:
        raise NotFoundError(
            f"{body.channel} has no active monitoring session: it must be on your watchlist, live, and monitoring must be on",
            code="not_monitoring",
        )
    now = utcnow()
    skew = now - body.sent_at  # browser clock → server clock
    chat = request.app.state.chat
    accepted = chat.ingest_audio(session.streamer_id, [(s.t + skew, s.db) for s in body.samples], now)
    sound_state, sounds = "off", None
    if body.pcm is not None and session.streamer_id in chat.tracked:
        sound_state, sounds = await _classify_live(request, chat, session.streamer_id, body, skew, now)
    state = chat.audio[session.streamer_id].status(now)["audio_state"] if session.streamer_id in chat.audio else "off"
    return LiveAudioOut(session_id=session.id, streamer_id=session.streamer_id, accepted=accepted, audio_state=str(state),
                        sound_state=sound_state, sounds=sounds)


async def _classify_live(request: Request, chat, streamer_id: int, body: LiveAudioIn, skew: timedelta, now) -> tuple[str, dict[str, float] | None]:  # type: ignore[no-untyped-def]
    """Laughter / cheering / screaming in the tab audio of this batch. The samples are dropped afterwards."""
    import numpy as np

    assert body.pcm is not None
    classifier = request.app.state.media_jobs.sound_classifier
    if not request.app.state.settings.sound_events_enabled or classifier is None or not classifier.available:
        chat.set_sound_state(streamer_id, "not_installed")
        return "not_installed", None
    try:
        raw = base64.b64decode(body.pcm.data, validate=True)
    except (binascii.Error, ValueError):
        raise AppError("The audio data is not valid base64", code="invalid_audio") from None
    pcm = np.frombuffer(raw[: len(raw) - len(raw) % 2], dtype="<i2").astype(np.float32) / 32768.0
    try:
        windows = await classifier.classify_pcm(pcm)
    except MediaProcessingError as exc:
        state = f"failed: {exc.message}"
        chat.set_sound_state(streamer_id, state)
        return state, None
    start = body.pcm.start + skew
    chat.ingest_sounds(streamer_id, [(start + timedelta(seconds=off), v) for off, v in windows], now)
    if not windows:
        return "receiving", None
    return "receiving", {k: round(max(v.get(k, 0.0) for _, v in windows), 3) for k in windows[0][1]}


@router.get("", response_model=Page[MonitoringSessionOut], summary="Monitoring session history")
async def list_sessions(
    svc: ActivityServiceDep, page: PageDep, status: MonitoringSessionStatus | None = None
) -> Page[MonitoringSessionOut]:
    return await svc.list_sessions(limit=page.limit, offset=page.offset, status=status)


@router.get("/{session_id}", response_model=MonitoringSessionOut, summary="One monitoring session")
async def get_session(session_id: int, svc: ActivityServiceDep) -> MonitoringSessionOut:
    return session_out(await svc.get_session(session_id))


@router.post("/{session_id}/vod", response_model=MonitoringSessionOut, summary="Look up the platform VOD now (Twitch)")
async def find_vod(session_id: int, request: Request, svc: ActivityServiceDep, db: DbDep) -> MonitoringSessionOut:
    session = await svc.get_session(session_id)
    await lookup_vod(session, request.app.state.registry)
    await db.flush()
    return session_out(session)


@router.get("/{session_id}/activity", summary="Live chat activity for a session (aggregates only, no messages)")
async def session_activity(session_id: int, request: Request, svc: ActivityServiceDep) -> dict[str, object]:
    session = await svc.get_session(session_id)  # ownership check
    data = request.app.state.chat.activity(session.streamer_id, utcnow())
    if session.status != MonitoringSessionStatus.ACTIVE.value:
        data["chat_state"] = "not_monitored"
    return {"session_id": session.id, "streamer_id": session.streamer_id, **data}


@router.get("/{session_id}/events", response_model=Page[StreamEventOut], summary="Events of a session")
async def list_events(session_id: int, svc: ActivityServiceDep, page: PageDep) -> Page[StreamEventOut]:
    return await svc.list_events(session_id, limit=page.limit, offset=page.offset)
