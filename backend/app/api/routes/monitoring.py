"""Browser-based monitoring: lease (heartbeat/start/stop), status, session history."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import func, select

from app.api.dependencies import ActivityServiceDep, CurrentUser, DbDep, PageDep
from app.db.types import utcnow
from app.domain.enums import MonitoringSessionStatus
from app.models import HighlightCandidate, MonitoringLease, MonitoringSession, Streamer, UserStreamer
from app.monitoring.engine import MonitoringEngine
from app.schemas.activity import (
    HeartbeatOut,
    HeartbeatRequest,
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
