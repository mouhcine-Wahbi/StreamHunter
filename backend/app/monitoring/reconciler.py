"""Session lifecycle rules. Pure decisions + DB writes, no platform calls.

For one (user, streamer) pair, given the latest open session:

    want = lease active AND user monitors the streamer AND streamer is live

    want  & no open session                → open a new session        (stream_online)
    want  & paused, same broadcast         → resume it
    want  & paused/active, other broadcast → end it, open a new one    (stream restarted)
    !want & active, streamer offline       → end it                    (stream_offline)
    !want & active, no lease               → pause it                  (browser gone)
    !want & active, monitoring disabled    → end it
    paused & streamer offline              → end it
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.enums import MonitoringSessionStatus as SS
from app.models import MonitoringSession, StreamEvent, Streamer


@dataclass(slots=True)
class ReconcileStats:
    opened: int = 0
    resumed: int = 0
    paused: int = 0
    ended: int = 0
    went_live: list[tuple[int, int]] = field(default_factory=list)  # (user_id, streamer_id)


def _same_broadcast(a: datetime | None, b: datetime | None) -> bool:
    # If the platform gave no start time we can't tell broadcasts apart; assume same.
    return a is None or b is None or abs((a - b).total_seconds()) < 5


def _event(db: AsyncSession, session: MonitoringSession, streamer: Streamer, kind: str, now: datetime) -> None:
    offset = (now - session.broadcast_started_at).total_seconds() if session.broadcast_started_at else None
    db.add(
        StreamEvent(
            session_id=session.id,
            streamer_id=streamer.id,
            event_type=kind,
            platform_timestamp=None,
            stream_offset_sec=offset if offset is None or offset >= 0 else None,
            confidence=1.0,
            event_metadata={"title": streamer.current_title, "category": streamer.current_category},
        )
    )
    session.last_event_at = now


async def reconcile(
    db: AsyncSession,
    *,
    user_id: int,
    streamer: Streamer,
    session: MonitoringSession | None,
    lease_active: bool,
    monitoring_enabled: bool,
    now: datetime,
    stats: ReconcileStats,
) -> None:
    live = streamer.is_live is True
    want = lease_active and monitoring_enabled and live

    async def open_new() -> None:
        s = MonitoringSession(
            user_id=user_id,
            streamer_id=streamer.id,
            platform=streamer.platform,
            started_at=now,
            status=SS.ACTIVE.value,
            last_checked_at=now,
            broadcast_started_at=streamer.stream_started_at,
        )
        db.add(s)
        await db.flush()
        _event(db, s, streamer, "stream_online", now)
        stats.opened += 1
        stats.went_live.append((user_id, streamer.id))

    def end(s: MonitoringSession, reason: str | None = None) -> None:
        s.status = SS.ENDED.value
        s.ended_at = now
        if reason:
            _event(db, s, streamer, reason, now)
        stats.ended += 1

    if want:
        if session is None:
            await open_new()
        elif not _same_broadcast(session.broadcast_started_at, streamer.stream_started_at):
            end(session, "stream_offline")
            await open_new()
        elif session.status == SS.PAUSED.value:
            session.status = SS.ACTIVE.value
            session.error_message = None
            session.last_checked_at = now
            stats.resumed += 1
        else:
            session.last_checked_at = now
        return

    if session is None:
        return
    if session.status == SS.ACTIVE.value:
        if streamer.is_live is False:
            end(session, "stream_offline")
        elif not lease_active:
            session.status = SS.PAUSED.value
            stats.paused += 1
        elif not monitoring_enabled:
            end(session)
    elif session.status == SS.PAUSED.value and streamer.is_live is False:
        end(session, "stream_offline")
