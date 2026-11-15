"""Inbound platform webhooks. Kick delivers chat only this way (signed, public HTTPS)."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.domain.enums import Platform
from app.errors import AuthError, PlatformUnavailableError
from app.integrations.kick.adapter import KickAdapter
from app.integrations.kick.chat import CHAT_EVENT, KickWebhookVerifier, parse_chat_event

log = logging.getLogger("streamhunter.webhooks")
router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])

MAX_BODY = 64 * 1024


@router.post("/kick", summary="Kick event webhook (configure {KICK_WEBHOOK_PUBLIC_URL}/api/v1/webhooks/kick in Kick)")
async def kick_webhook(request: Request) -> JSONResponse:
    adapter = request.app.state.registry.get(Platform.KICK)
    if not isinstance(adapter, KickAdapter) or adapter.api is None:
        raise PlatformUnavailableError("Kick is not configured on this backend", code="platform_not_configured")
    body = await request.body()
    if len(body) > MAX_BODY:
        raise AuthError("Payload too large", code="payload_rejected")
    verifier: KickWebhookVerifier | None = request.app.state.kick_verifier
    if verifier is None:
        verifier = request.app.state.kick_verifier = KickWebhookVerifier(adapter.api.public_key_pem)
    ok, reason = await verifier.verify(request.headers, body)
    if not ok:
        log.warning("kick_webhook_rejected", extra={"reason": reason})
        raise AuthError(f"Webhook rejected: {reason}", code="invalid_signature")

    event_type = request.headers.get("Kick-Event-Type", "")
    accepted = False
    if event_type == CHAT_EVENT:
        try:
            payload = json.loads(body)
        except ValueError:
            return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)
        msg = parse_chat_event(payload, datetime.now(UTC)) if isinstance(payload, dict) else None
        if msg is not None:
            accepted = request.app.state.chat.ingest(msg)
    # Always 200 for verified deliveries so Kick doesn't retry or unsubscribe us.
    return JSONResponse({"ok": True, "accepted": accepted})
