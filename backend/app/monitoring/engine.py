"""Browser-leased monitoring engine.

* `heartbeat` grants/extends a user's lease (called by the extension on every alarm).
* `run_cycle` (background scheduler, and immediately when a lease starts):
    1. pauses sessions of users whose lease expired;
    2. polls live status for streamers that leased users monitor, batched per platform,
       at most once per (shortest user interval, but ≥ MIN_POLL_SECONDS);
    3. opens / resumes / pauses / ends sessions (see reconciler.py).
Only one cycle runs at a time per process.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.db.types import utcnow
from app.domain.enums import MonitoringSessionStatus as SS
from app.integrations.registry import PlatformRegistry
from app.models import MonitoringLease, MonitoringSession, StreamEvent, Streamer, User, UserStreamer
from app.monitoring.reconciler import ReconcileStats, reconcile
from app.services.stream_status_service import StreamStatusService

log = logging.getLogger("streamhunter.monitoring")

MIN_INTERVAL, MAX_INTERVAL = 60, 3600
# After a platform failure, wait 30 s, 60 s, 120 s, … up to 15 min before polling it again.
BACKOFF_BASE, BACKOFF_MAX = 30, 900


@dataclass(slots=True)
class PlatformBackoff:
    failures: int = 0
    until: datetime | None = None

    def blocked(self, now: datetime) -> bool:
        return self.until is not None and now < self.until

    def fail(self, now: datetime) -> None:
        self.failures += 1
        self.until = now + timedelta(seconds=min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (self.failures - 1)))

    def ok(self) -> None:
        self.failures, self.until = 0, None


@dataclass(slots=True)
class CycleSummary:
    active_users: int = 0
    polled: int = 0
    unavailable: dict[str, str] = field(default_factory=dict)
    backed_off: list[str] = field(default_factory=list)
    stats: ReconcileStats = field(default_factory=ReconcileStats)


@dataclass(slots=True)
class HeartbeatResult:
    lease: MonitoringLease
    started: bool  # lease was (re)activated by this heartbeat


class MonitoringEngine:
    def __init__(self, maker: async_sessionmaker[AsyncSession], registry: PlatformRegistry, settings: Settings):
        self.maker = maker
        self.registry = registry
        self.settings = settings
        self._lock = asyncio.Lock()
        self.last_cycle: CycleSummary | None = None
        self.last_cycle_at: datetime | None = None
        self.backoff: dict[str, PlatformBackoff] = {}

    # --- lease ------------------------------------------------------------------------------
    def lease_ttl(self, interval_seconds: int) -> timedelta:
        return timedelta(seconds=max(self.settings.monitoring_lease_ttl_seconds, 3 * interval_seconds + 60))

    async def heartbeat(self, db: AsyncSession, user: User, *, client: str, interval_seconds: int) -> HeartbeatResult:
        now = utcnow()
        interval = min(MAX_INTERVAL, max(MIN_INTERVAL, interval_seconds))
        lease = await db.scalar(select(MonitoringLease).where(MonitoringLease.user_id == user.id))
        started = lease is None or not lease.is_active(now)
        if lease is None:
            lease = MonitoringLease(user_id=user.id, client=client[:64], interval_seconds=interval, started_at=now,
                                    last_heartbeat_at=now, expires_at=now)
            db.add(lease)
        if started:
            lease.started_at = now
            lease.released_at = None
        lease.client = client[:64]
        lease.interval_seconds = interval
        lease.last_heartbeat_at = now
        lease.expires_at = now + self.lease_ttl(interval)
        await db.flush()
        return HeartbeatResult(lease=lease, started=started)

    async def release(self, db: AsyncSession, user: User) -> None:
        lease = await db.scalar(select(MonitoringLease).where(MonitoringLease.user_id == user.id))
        if lease is not None and lease.released_at is None:
            now = utcnow()
            lease.released_at = now
            lease.expires_at = min(lease.expires_at, now)
            await db.flush()

    # --- cycle -------------------------------------------------------------------------------
    async def run_cycle(self, *, only_users: set[int] | None = None) -> CycleSummary:
        async with self._lock, self.maker() as db:
            try:
                summary = await self._cycle(db, only_users)
                await db.commit()
            except Exception:
                await db.rollback()
                raise
        if only_users is None:
            self.last_cycle, self.last_cycle_at = summary, utcnow()
        return summary

    async def _cycle(self, db: AsyncSession, only_users: set[int] | None) -> CycleSummary:
        now = utcnow()
        summary = CycleSummary()
        leases = {
            l.user_id: l
            for l in (await db.scalars(select(MonitoringLease))).all()
            if l.is_active(now) and (only_users is None or l.user_id in only_users)
        }
        summary.active_users = len(leases)

        # 1. Users without an active lease: pause their active sessions (whole-system pass only).
        if only_users is None:
            orphaned = await db.scalars(select(MonitoringSession).where(MonitoringSession.status == SS.ACTIVE.value))
            for s in orphaned.unique():
                lease = await db.scalar(select(MonitoringLease).where(MonitoringLease.user_id == s.user_id))
                if lease is None or not lease.is_active(now):
                    await reconcile(db, user_id=s.user_id, streamer=s.streamer, session=s, lease_active=False,
                                    monitoring_enabled=True, now=now, stats=summary.stats)

        if not leases:
            await db.flush()
            return summary

        # 2. What do leased users watch, and how often may each streamer be polled?
        entries = (
            await db.scalars(select(UserStreamer).where(UserStreamer.user_id.in_(leases.keys())))
        ).unique().all()
        interval: dict[int, int] = {}
        streamers: dict[int, Streamer] = {}
        for e in entries:
            if not e.monitoring_enabled:
                continue
            streamers[e.streamer_id] = e.streamer
            lease_iv = leases[e.user_id].interval_seconds
            interval[e.streamer_id] = min(interval.get(e.streamer_id, lease_iv), lease_iv)

        floor = self.settings.min_poll_seconds
        due: list[Streamer] = []
        for sid, s in streamers.items():
            backoff = self.backoff.get(s.platform)
            if backoff and backoff.blocked(now):
                if s.platform not in summary.backed_off:
                    summary.backed_off.append(s.platform)
                continue  # platform failing: don't hammer it
            every = timedelta(seconds=floor if only_users else max(floor, interval[sid]))
            if s.status_checked_at is None or now - s.status_checked_at >= every:
                due.append(s)
        if due:
            refresh = await StreamStatusService(db, self.registry).refresh_streamers(due, force=True)
            summary.polled = refresh.checked
            summary.unavailable = refresh.unavailable
            for platform in {s.platform for s in due}:
                b = self.backoff.setdefault(platform, PlatformBackoff())
                if platform in refresh.unavailable:
                    b.fail(now)
                else:
                    b.ok()
            if refresh.unavailable:
                log.warning(
                    "status_poll_unavailable",
                    extra={"platforms": refresh.unavailable,
                           "retry_in_s": {p: int((self.backoff[p].until - now).total_seconds()) for p in refresh.unavailable}},
                )

        # 3. Reconcile every (user, streamer) pair of leased users, plus their open sessions.
        open_sessions: dict[tuple[int, int], MonitoringSession] = {}
        rows = await db.scalars(
            select(MonitoringSession)
            .where(MonitoringSession.user_id.in_(leases.keys()), MonitoringSession.status.in_([SS.ACTIVE.value, SS.PAUSED.value]))
            .order_by(MonitoringSession.started_at)
        )
        for s in rows.unique():
            open_sessions[(s.user_id, s.streamer_id)] = s  # latest wins

        pairs: dict[tuple[int, int], bool] = {(e.user_id, e.streamer_id): e.monitoring_enabled for e in entries}
        for key in open_sessions:
            pairs.setdefault(key, False)  # removed from watchlist → treated as not monitored
        streamer_rows = {s.id: s for s in streamers.values()}
        for (uid, sid), enabled in pairs.items():
            streamer = streamer_rows.get(sid) or (open_sessions[(uid, sid)].streamer if (uid, sid) in open_sessions else None)
            if streamer is None:
                continue
            await reconcile(db, user_id=uid, streamer=streamer, session=open_sessions.get((uid, sid)),
                            lease_active=True, monitoring_enabled=enabled, now=now, stats=summary.stats)
        await db.flush()
        if summary.stats.opened or summary.stats.ended:
            log.info("monitoring_transitions", extra={"opened": summary.stats.opened, "ended": summary.stats.ended,
                                                      "paused": summary.stats.paused, "resumed": summary.stats.resumed})
        return summary

    # --- notifications for the extension ------------------------------------------------
    async def recent_events(self, db: AsyncSession, user: User, since: datetime, kinds: tuple[str, ...]) -> list[tuple[StreamEvent, Streamer]]:
        rows = await db.execute(
            select(StreamEvent, Streamer)
            .join(MonitoringSession, MonitoringSession.id == StreamEvent.session_id)
            .join(Streamer, Streamer.id == StreamEvent.streamer_id)
            .where(MonitoringSession.user_id == user.id, StreamEvent.created_at > since, StreamEvent.event_type.in_(kinds))
            .order_by(StreamEvent.created_at)
            .limit(50)
        )
        return [(e, s) for e, s in rows.all()]

