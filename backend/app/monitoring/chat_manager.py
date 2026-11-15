"""Chat collection + analysis for streamers with active monitoring sessions.

* `sync()` (after every monitoring cycle) starts/stops collectors to match active sessions:
    - Twitch: an EventSub WebSocket per authorizing user (needs `user:read:chat`);
    - Kick: a webhook subscription per channel (needs KICK_WEBHOOK_PUBLIC_URL).
  When chat can't be collected the reason is written to the sessions (`error_message`).
* `ingest()` receives normalized messages from either platform.
* `analyze()` (every 5 s) runs the detectors and stores candidates for every user with an
  active session on that streamer, filtered by each user's sensitivity.
One analyzer per streamer is shared by all users monitoring it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.detection.analyzer import StreamAnalyzer
from app.detection.models import CandidateDraft, ChatMessage, Strictness
from app.domain.enums import ClipStatus, ConnectionStatus, MonitoringSessionStatus as SS, Platform
from app.errors import AppError
from app.integrations.kick.adapter import KickAdapter
from app.integrations.kick.chat import CHAT_EVENT
from app.integrations.registry import PlatformRegistry
from app.integrations.twitch.adapter import TwitchAdapter
from app.integrations.twitch.chat import TwitchChatConnection
from app.models import HighlightCandidate, MonitoringSession, PlatformConnection, StreamEvent, Streamer, User, UserSettings
from app.schemas.settings import UserSettingsModel
from app.services.clip_service import auto_capture_candidates
from app.services.connection_service import ConnectionService
from app.utils.crypto import TokenCipher

log = logging.getLogger("streamhunter.chat")

ANALYZE_EVERY = 5  # seconds (= bucket size)
RETRY_FAILED_AFTER = timedelta(minutes=5)


@dataclass(slots=True)
class ChatState:
    platform: Platform
    state: str  # connecting | connected | unavailable
    reason: str | None = None


@dataclass(slots=True)
class _Tracked:
    streamer_id: int
    platform: Platform
    broadcaster_id: str
    analyzer: StreamAnalyzer
    twitch_owner: int | None = None  # StreamHunter user whose Twitch token collects this chat
    kick_subscriptions: list[str] | None = None
    failed_at: datetime | None = None


class ChatManager:
    def __init__(self, maker: async_sessionmaker[AsyncSession], registry: PlatformRegistry, cipher: TokenCipher,
                 *, twitch_connect: Any = None):
        self.maker = maker
        self.registry = registry
        self.cipher = cipher
        self._twitch_connect = twitch_connect  # injectable for tests
        self.tracked: dict[int, _Tracked] = {}  # streamer_id → state
        self.by_channel: dict[tuple[Platform, str], int] = {}  # (platform, broadcaster_id) → streamer_id
        self.states: dict[int, ChatState] = {}
        self.twitch_connections: dict[int, TwitchChatConnection] = {}  # StreamHunter user id → connection
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self.clip_worker: Any = None  # ClipWorker, set by the app (auto-capture of Twitch clips)
        self._pending_capture: list[int] = []

    # --- message intake ------------------------------------------------------------------------
    def ingest(self, msg: ChatMessage) -> bool:
        sid = self.by_channel.get((msg.platform, msg.broadcaster_id))
        if sid is None:
            return False  # not monitored (e.g. a webhook for a channel we just stopped)
        t = self.tracked[sid]
        t.analyzer.add(msg)
        st = self.states.get(sid)
        if st and st.state != "connected":
            self.states[sid] = ChatState(t.platform, "connected")
        return True

    def _channel_error(self, platform: Platform, broadcaster_id: str, reason: str) -> None:
        sid = self.by_channel.get((platform, broadcaster_id))
        if sid is not None:
            self.states[sid] = ChatState(platform, "unavailable", reason)
            self.tracked[sid].failed_at = datetime.now(UTC)
            log.warning("chat_channel_error", extra={"streamer_id": sid, "reason": reason})

    # --- lifecycle -----------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="streamhunter-chat-analysis")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        for sid in list(self.tracked):
            await self._untrack(sid)
        for conn in list(self.twitch_connections.values()):
            await conn.stop()
        self.twitch_connections.clear()

    async def _loop(self) -> None:
        while True:
            try:
                await self.analyze(datetime.now(UTC))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("chat_analysis_failed")
            await asyncio.sleep(ANALYZE_EVERY)

    # --- sync with sessions --------------------------------------------------------------------
    async def sync(self) -> None:
        async with self._lock, self.maker() as db:
            sessions = (
                await db.scalars(select(MonitoringSession).where(MonitoringSession.status == SS.ACTIVE.value))
            ).unique().all()
            by_streamer: dict[int, list[MonitoringSession]] = {}
            for s in sessions:
                by_streamer.setdefault(s.streamer_id, []).append(s)

            for sid in [sid for sid in self.tracked if sid not in by_streamer]:
                await self._persist(db, self.tracked[sid].analyzer.flush(), sid)
                await self._untrack(sid)

            users = {s.user_id for s in sessions}
            settings = await self._settings(db, users)
            for sid, group in by_streamer.items():
                streamer = group[0].streamer
                t = self.tracked.get(sid) or self._track(streamer)
                watchers = [settings[s.user_id] for s in group]
                t.analyzer.configure(
                    languages={lang for w in watchers for lang in w.detection.keywordLanguages},
                    custom_keywords={k for w in watchers for k in w.detection.customKeywords},
                )
                if t.platform == Platform.TWITCH:
                    await self._ensure_twitch(db, t, [s.user_id for s in group])
                else:
                    await self._ensure_kick(t)
                state = self.states.get(sid)
                reason = state.reason if state and state.state == "unavailable" else None
                for s in group:
                    s.error_message = reason
            await self._prune_twitch_connections()
            await db.commit()

    def _track(self, streamer: Streamer) -> _Tracked:
        platform = Platform(streamer.platform)
        t = _Tracked(streamer.id, platform, streamer.platform_user_id,
                     StreamAnalyzer(platform, streamer.platform_user_id, broadcaster_login=streamer.username))
        self.tracked[streamer.id] = t
        self.by_channel[(platform, streamer.platform_user_id)] = streamer.id
        self.states[streamer.id] = ChatState(platform, "connecting")
        return t

    async def _untrack(self, sid: int) -> None:
        t = self.tracked.pop(sid, None)
        if t is None:
            return
        self.by_channel.pop((t.platform, t.broadcaster_id), None)
        self.states.pop(sid, None)
        if t.twitch_owner is not None and (conn := self.twitch_connections.get(t.twitch_owner)):
            await conn.set_channels(conn.desired - {t.broadcaster_id})
        if t.kick_subscriptions:
            adapter = self.registry.get(Platform.KICK)
            if isinstance(adapter, KickAdapter) and adapter.api:
                with contextlib.suppress(AppError):
                    await adapter.api.unsubscribe_events(t.kick_subscriptions)

    async def _settings(self, db: AsyncSession, user_ids: set[int]) -> dict[int, UserSettingsModel]:
        rows = (await db.execute(select(UserSettings.user_id, UserSettings.settings).where(UserSettings.user_id.in_(user_ids)))).all()
        out = {uid: UserSettingsModel() for uid in user_ids}
        for uid, data in rows:
            with contextlib.suppress(Exception):
                out[uid] = UserSettingsModel.model_validate(data)
        return out

    def _retry_blocked(self, t: _Tracked) -> bool:
        return t.failed_at is not None and datetime.now(UTC) - t.failed_at < RETRY_FAILED_AFTER

    async def _ensure_twitch(self, db: AsyncSession, t: _Tracked, user_ids: list[int]) -> None:
        adapter = self.registry.get(Platform.TWITCH)
        if not isinstance(adapter, TwitchAdapter) or not adapter.client_id:
            self.states[t.streamer_id] = ChatState(t.platform, "unavailable", "Twitch is not configured on the backend.")
            return
        if self._retry_blocked(t):
            return
        if t.twitch_owner in user_ids and t.twitch_owner in self.twitch_connections:
            return  # already collected through a watcher's connection
        owners = (
            await db.scalars(
                select(PlatformConnection).where(
                    PlatformConnection.platform == Platform.TWITCH.value,
                    PlatformConnection.user_id.in_(user_ids),
                    PlatformConnection.connection_status == ConnectionStatus.CONNECTED.value,
                )
            )
        ).all()
        owner = next((c for c in sorted(owners, key=lambda c: c.user_id) if "user:read:chat" in (c.scopes or [])), None)
        if owner is None or not owner.platform_user_id:
            self.states[t.streamer_id] = ChatState(
                t.platform, "unavailable",
                "Chat needs a connected Twitch account with chat permission (Settings → Platform connections).",
            )
            return
        conn = self.twitch_connections.get(owner.user_id)
        if conn is None:
            conn = TwitchChatConnection(
                client_id=adapter.client_id,
                token_user_id=owner.platform_user_id,
                token=self._token_provider(owner.user_id),
                on_message=self.ingest,
                on_channel_error=lambda bid, reason: self._channel_error(Platform.TWITCH, bid, reason),
                http=adapter.http,
                **({"connect": self._twitch_connect} if self._twitch_connect else {}),
            )
            self.twitch_connections[owner.user_id] = conn
            conn.start()
        t.twitch_owner = owner.user_id
        t.failed_at = None
        self.states[t.streamer_id] = ChatState(t.platform, "connecting")
        await conn.set_channels(conn.desired | {t.broadcaster_id})

    def _token_provider(self, user_id: int):  # type: ignore[no-untyped-def]
        async def token() -> str:
            async with self.maker() as db:
                user = await db.get(User, user_id)
                assert user is not None
                tok = await ConnectionService(db, self.registry, self.cipher).access_token(user, Platform.TWITCH)
                await db.commit()  # persist a refreshed token
                return tok

        return token

    async def _prune_twitch_connections(self) -> None:
        in_use = {t.twitch_owner for t in self.tracked.values() if t.twitch_owner is not None}
        for uid in [u for u in self.twitch_connections if u not in in_use]:
            await self.twitch_connections.pop(uid).stop()

    async def _ensure_kick(self, t: _Tracked) -> None:
        adapter = self.registry.get(Platform.KICK)
        if not isinstance(adapter, KickAdapter) or not adapter.webhook_configured or adapter.api is None:
            self.states[t.streamer_id] = ChatState(
                t.platform, "unavailable",
                "Kick chat needs KICK_CLIENT_ID/SECRET and a public HTTPS webhook URL (KICK_WEBHOOK_PUBLIC_URL).",
            )
            return
        if t.kick_subscriptions or self._retry_blocked(t):
            return
        try:
            t.kick_subscriptions = await adapter.api.subscribe_events(t.broadcaster_id, [CHAT_EVENT])
            t.failed_at = None
            self.states[t.streamer_id] = ChatState(t.platform, "connecting")
        except AppError as exc:
            self._channel_error(Platform.KICK, t.broadcaster_id, f"Kick chat subscription failed: {exc.message}")

    # --- analysis ------------------------------------------------------------------------------
    async def analyze(self, now: datetime) -> int:
        drafts = [(sid, t.analyzer.evaluate(now)) for sid, t in list(self.tracked.items())]
        drafts = [(sid, d) for sid, d in drafts if d is not None]
        if not drafts:
            return 0
        created = 0
        async with self.maker() as db:
            for sid, draft in drafts:
                created += await self._persist(db, draft, sid)
            await db.commit()
        # Twitch clips what's on air *now*: request them right after commit, not at review time.
        captures, self._pending_capture = self._pending_capture, []
        if self.clip_worker is not None:
            for clip_id in captures:
                self.clip_worker.spawn(self.clip_worker.request(clip_id))
        return created

    async def _persist(self, db: AsyncSession, draft: CandidateDraft | None, streamer_id: int) -> int:
        if draft is None:
            return 0
        sessions = (
            await db.scalars(
                select(MonitoringSession).where(
                    MonitoringSession.streamer_id == streamer_id, MonitoringSession.status == SS.ACTIVE.value
                )
            )
        ).unique().all()
        if not sessions:
            return 0
        settings = await self._settings(db, {s.user_id for s in sessions})
        created = 0
        new_candidates: list[HighlightCandidate] = []
        for s in sessions:
            us = settings[s.user_id]
            if draft.strictness < Strictness.for_setting(us.detection.sensitivity):
                continue  # not convincing enough for this user's sensitivity
            start = draft.start_at - timedelta(seconds=us.clips.preRollSeconds)
            end = draft.end_at + timedelta(seconds=us.clips.postRollSeconds)

            def offset(ts: datetime) -> float | None:
                if s.broadcast_started_at is None:
                    return None  # never guessed
                return max(0.0, round((ts - s.broadcast_started_at).total_seconds(), 1))

            cand = HighlightCandidate(
                    user_id=s.user_id,
                    session_id=s.id,
                    streamer_id=streamer_id,
                    platform=s.platform,
                    timestamp=draft.peak_at,
                    start_offset_sec=offset(start),
                    end_offset_sec=offset(end),
                    score=draft.score,
                    confidence=draft.confidence,
                    category=draft.category,
                    reasons=draft.reasons,
                    signal_breakdown={
                        **draft.signal_breakdown,
                        "window": {"start": start.isoformat(), "end": end.isoformat(), "peak": draft.peak_at.isoformat()},
                        "offsets_approximate": s.broadcast_started_at is not None,
                        "strictness": draft.strictness.name.lower(),
                    },
                    status=ClipStatus.PENDING_REVIEW.value,
                )
            db.add(cand)
            new_candidates.append(cand)
            for e in draft.events:
                db.add(
                    StreamEvent(
                        session_id=s.id,
                        streamer_id=streamer_id,
                        event_type=e.event_type,
                        platform_timestamp=None,
                        stream_offset_sec=offset(e.timestamp),
                        confidence=e.confidence,
                        event_metadata={**e.metadata, "score": e.score, "reason": e.reason},
                    )
                )
            s.last_event_at = datetime.now(UTC)
            created += 1
        await db.flush()
        if self.clip_worker is not None and new_candidates:
            self._pending_capture += await auto_capture_candidates(db, new_candidates)
        if created:
            log.info("highlight_candidates_created", extra={"streamer_id": streamer_id, "count": created,
                                                           "score": draft.score, "category": draft.category})
        return created

    # --- read model for the UI -------------------------------------------------------------------
    def activity(self, streamer_id: int, now: datetime) -> dict[str, Any]:
        t = self.tracked.get(streamer_id)
        st = self.states.get(streamer_id)
        base: dict[str, Any] = {
            "chat_state": st.state if st else "not_monitored",
            "chat_reason": st.reason if st else None,
        }
        if t:
            base.update(t.analyzer.activity(now))
        return base
