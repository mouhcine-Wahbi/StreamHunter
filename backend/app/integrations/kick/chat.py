"""Kick chat via signed webhooks (`chat.message.sent`, v1).

Verified in KickEngineering/KickDevDocs: events are POSTed to the app's webhook URL with
headers Kick-Event-Message-Id / -Subscription-Id / -Signature / -Message-Timestamp / -Type /
-Version. The signature is RSA PKCS#1 v1.5 + SHA-256 over "{id}.{timestamp}.{body}",
base64-encoded, verifiable with the key from GET /public/v1/public-key.

The JSON field names of the subscription request/response and of the chat payload come from
the OpenAPI spec, which could not be fetched here: they are parsed defensively (see
kick/schemas.py) and covered by the opt-in integration tests.
"""

from __future__ import annotations

import base64
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.detection.models import ChatMessage
from app.domain.enums import Platform

log = logging.getLogger("streamhunter.kick.chat")

CHAT_EVENT = "chat.message.sent"
MAX_CLOCK_SKEW = timedelta(minutes=5)
_EMOTE_TAG = re.compile(r"\[emote:(\d+):([^\]]{1,64})\]")


class KickWebhookVerifier:
    def __init__(self, fetch_public_key: Callable[[], Awaitable[str]], *, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._fetch = fetch_public_key
        self._now = now
        self._key: rsa.RSAPublicKey | None = None
        self._seen: OrderedDict[str, None] = OrderedDict()  # replay protection (bounded)

    async def _public_key(self, refresh: bool = False) -> rsa.RSAPublicKey:
        if self._key is None or refresh:
            pem = await self._fetch()
            key = serialization.load_pem_public_key(pem.encode())
            if not isinstance(key, rsa.RSAPublicKey):
                raise ValueError("Kick public key is not RSA")
            self._key = key
        return self._key

    async def verify(self, headers: Mapping[str, str], body: bytes) -> tuple[bool, str]:
        """(ok, reason). Rejects bad signatures, stale/future timestamps and replays."""
        h = {k.lower(): v for k, v in headers.items()}
        msg_id, ts, sig = h.get("kick-event-message-id"), h.get("kick-event-message-timestamp"), h.get("kick-event-signature")
        if not (msg_id and ts and sig):
            return False, "missing signature headers"
        try:
            when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return False, "bad timestamp"
        if when.tzinfo is None or abs(self._now() - when) > MAX_CLOCK_SKEW:
            return False, "timestamp outside the allowed window"
        if msg_id in self._seen:
            return False, "duplicate message"
        try:
            signature = base64.b64decode(sig, validate=True)
        except ValueError:
            return False, "bad signature encoding"
        signed = msg_id.encode() + b"." + ts.encode() + b"." + body
        for refresh in (False, True):  # retry once with a fresh key (rotation)
            try:
                key = await self._public_key(refresh=refresh)
                key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
                self._seen[msg_id] = None
                while len(self._seen) > 10_000:
                    self._seen.popitem(last=False)
                return True, "ok"
            except InvalidSignature:
                continue
        return False, "invalid signature"


def parse_chat_event(body: dict[str, Any], received_at: datetime) -> ChatMessage | None:
    """Normalizes a chat.message.sent payload. Kick embeds emotes as [emote:ID:NAME]."""
    broadcaster = (body.get("broadcaster") or {}).get("user_id")
    sender = body.get("sender") or {}
    if broadcaster is None or sender.get("user_id") is None:
        return None
    content = str(body.get("content") or "")
    names = tuple(m.group(2) for m in _EMOTE_TAG.finditer(content))
    text = _EMOTE_TAG.sub(lambda m: m.group(2), content)
    return ChatMessage(
        platform=Platform.KICK,
        broadcaster_id=str(broadcaster),
        user_id=str(sender["user_id"]),
        user_login=str(sender.get("username") or sender["user_id"]),
        text=text,
        emotes=names,
        received_at=received_at,
    )
