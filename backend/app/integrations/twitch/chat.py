"""Twitch chat via EventSub WebSocket (`channel.chat.message`, v1).

One connection per authorizing StreamHunter user (Twitch requires a *user* token with
`user:read:chat`; the condition's `user_id` is that user). Each connection carries the
subscriptions for every channel that user's token is used for.

Protocol handled (dev.twitch.tv/docs/eventsub/handling-websocket-events):
  session_welcome   → subscribe within 10 s using the session id
  session_keepalive → nothing; no message for keepalive_timeout_seconds ⇒ reconnect
  notification      → chat message → normalized ChatMessage
  session_reconnect → connect to reconnect_url; subscriptions carry over
  revocation        → drop that channel and report why
Reconnects use exponential backoff. Lost sessions (non-reconnect) resubscribe.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx

from app.detection.models import ChatMessage
from app.domain.enums import Platform
from app.errors import AppError
from app.integrations.http import RequestSpec, json_body, send
from app.integrations.twitch.client import HELIX_URL

log = logging.getLogger("streamhunter.twitch.chat")

EVENTSUB_WS = "wss://eventsub.wss.twitch.tv/ws"
SUB_TYPE = "channel.chat.message"

Connect = Callable[[str], Awaitable[Any]]  # returns an object with recv()/close() (websockets connection)


def _default_connect(url: str) -> Awaitable[Any]:
    from websockets.asyncio.client import connect

    return connect(url, max_size=2**20, ping_interval=None, open_timeout=10)


def parse_chat_notification(payload: dict[str, Any], received_at: datetime) -> ChatMessage | None:
    ev = payload.get("event") or {}
    msg = ev.get("message") or {}
    broadcaster = ev.get("broadcaster_user_id")
    chatter = ev.get("chatter_user_id")
    if not broadcaster or not chatter:
        return None
    emotes = tuple(
        f.get("text", "") for f in msg.get("fragments") or [] if f.get("type") == "emote" and f.get("text")
    )
    return ChatMessage(
        platform=Platform.TWITCH,
        broadcaster_id=str(broadcaster),
        user_id=str(chatter),
        user_login=str(ev.get("chatter_user_login") or chatter),
        text=str(msg.get("text") or ""),
        emotes=emotes,
        received_at=received_at,
    )


class TwitchChatConnection:
    def __init__(
        self,
        *,
        client_id: str,
        token_user_id: str,  # Twitch user id of the token owner (condition.user_id)
        token: Callable[[], Awaitable[str]],
        on_message: Callable[[ChatMessage], None],
        on_channel_error: Callable[[str, str], None],
        http: httpx.AsyncClient,
        connect: Connect = _default_connect,
        ws_url: str = EVENTSUB_WS,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        keepalive_grace: float = 5.0,
    ):
        self.client_id = client_id
        self.token_user_id = token_user_id
        self._token = token
        self._on_message = on_message
        self._on_channel_error = on_channel_error
        self._http = http
        self._connect = connect
        self._ws_url = ws_url
        self._now = now
        self._sleep = sleep
        self._grace = keepalive_grace
        self.desired: set[str] = set()
        self.subscriptions: dict[str, str] = {}  # broadcaster_id → subscription id
        self.session_id: str | None = None
        self.connected = asyncio.Event()
        self.failures = 0
        self._task: asyncio.Task[None] | None = None
        self._ws: Any = None
        self._stopping = False

    # --- public ------------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name=f"twitch-chat-{self.token_user_id}")

    async def stop(self) -> None:
        self._stopping = True
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        for bid in list(self.subscriptions):
            await self._unsubscribe(bid)

    async def set_channels(self, broadcaster_ids: set[str]) -> None:
        added, removed = broadcaster_ids - self.desired, self.desired - broadcaster_ids
        self.desired = set(broadcaster_ids)
        if self.session_id:
            for bid in removed:
                await self._unsubscribe(bid)
            for bid in added:
                await self._subscribe(bid)

    # --- subscription management -------------------------------------------------------------
    async def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {await self._token()}", "Client-Id": self.client_id}

    async def _subscribe(self, broadcaster_id: str) -> None:
        if broadcaster_id in self.subscriptions or not self.session_id:
            return
        body = {
            "type": SUB_TYPE,
            "version": "1",
            "condition": {"broadcaster_user_id": broadcaster_id, "user_id": self.token_user_id},
            "transport": {"method": "websocket", "session_id": self.session_id},
        }
        try:
            resp = await send(
                self._http,
                RequestSpec("twitch", "POST", f"{HELIX_URL}/eventsub/subscriptions", headers=await self._headers(), json=body),
            )
            data = (json_body(resp, "twitch") or {}).get("data") or [{}]
            self.subscriptions[broadcaster_id] = str(data[0].get("id", ""))
            log.info("twitch_chat_subscribed", extra={"broadcaster_id": broadcaster_id})
        except AppError as exc:
            self._on_channel_error(broadcaster_id, f"Twitch refused the chat subscription: {exc.message}")

    async def _unsubscribe(self, broadcaster_id: str) -> None:
        sub_id = self.subscriptions.pop(broadcaster_id, None)
        if not sub_id:
            return
        with contextlib.suppress(AppError):
            await send(
                self._http,
                RequestSpec("twitch", "DELETE", f"{HELIX_URL}/eventsub/subscriptions", params={"id": sub_id},
                            headers=await self._headers()),
                retries=0,
            )

    # --- connection loop -----------------------------------------------------------------------
    async def _run(self) -> None:
        url = self._ws_url
        while not self._stopping:
            reconnect_url: str | None = None
            try:
                async with await self._connect(url) as ws:
                    self._ws = ws
                    reconnect_url = await self._session(ws, resubscribe=url == self._ws_url)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network errors, protocol errors, timeouts
                log.warning("twitch_chat_connection_lost", extra={"error": type(exc).__name__})
            finally:
                self._ws = None
                self.connected.clear()
            if self._stopping:
                return
            if reconnect_url:
                url = reconnect_url  # Twitch asked us to move; subscriptions carry over
                continue
            # Session lost: subscriptions are gone on Twitch's side too.
            self.subscriptions.clear()
            self.session_id = None
            url = self._ws_url
            self.failures += 1
            await self._sleep(min(60.0, 2.0 ** min(self.failures, 6)))

    async def _session(self, ws: Any, *, resubscribe: bool) -> str | None:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if welcome.get("metadata", {}).get("message_type") != "session_welcome":
            raise RuntimeError("expected session_welcome")
        session = welcome["payload"]["session"]
        self.session_id = session["id"]
        keepalive = float(session.get("keepalive_timeout_seconds") or 10)
        self.connected.set()
        self.failures = 0
        if resubscribe:
            for bid in sorted(self.desired):
                await self._subscribe(bid)

        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=keepalive + self._grace)
            msg = json.loads(raw)
            kind = msg.get("metadata", {}).get("message_type")
            payload = msg.get("payload") or {}
            if kind == "notification" and payload.get("subscription", {}).get("type") == SUB_TYPE:
                parsed = parse_chat_notification(payload, self._now())
                if parsed is not None:
                    self._on_message(parsed)
            elif kind == "session_reconnect":
                return str(payload["session"]["reconnect_url"])
            elif kind == "revocation":
                cond = payload.get("subscription", {}).get("condition", {})
                bid = str(cond.get("broadcaster_user_id", ""))
                status = payload.get("subscription", {}).get("status", "revoked")
                self.subscriptions.pop(bid, None)
                self.desired.discard(bid)
                self._on_channel_error(bid, f"Twitch revoked the chat subscription ({status})")
            # session_keepalive and unknown types: nothing to do
