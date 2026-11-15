"""Platform account connections (OAuth) for the signed-in StreamHunter user.

Flow:
  1. Extension → GET /auth/{platform}/authorize (bearer) → authorization URL.
  2. The user approves on Twitch/Kick in a browser tab.
  3. Platform → GET /auth/{platform}/callback?code&state → tokens exchanged and
     stored encrypted; the tab shows a result page.
The `state` is random, single use, bound to the user and platform, and expires in 10 min.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.domain.enums import ConnectionStatus, Platform
from app.errors import AppError, PlatformUnavailableError
from app.integrations.base import OAuthProvider, TokenSet
from app.integrations.registry import PlatformRegistry
from app.models import OAuthState, PlatformConnection, User
from app.utils.crypto import TokenCipher
from app.utils.security import hash_token

log = logging.getLogger("streamhunter.connections")

STATE_TTL = timedelta(minutes=10)
REFRESH_MARGIN = timedelta(minutes=5)


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]  # 43–128 chars per RFC 7636
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


@dataclass(frozen=True, slots=True)
class CallbackResult:
    ok: bool
    platform: Platform
    message: str
    username: str | None = None


class ConnectionService:
    def __init__(self, db: AsyncSession, registry: PlatformRegistry, cipher: TokenCipher):
        self.db = db
        self.registry = registry
        self.cipher = cipher

    def _provider(self, platform: Platform) -> OAuthProvider:
        adapter = self.registry.get(platform)
        if not adapter.configured or adapter.oauth is None:
            raise PlatformUnavailableError(
                f"{platform.value.title()} is not configured on the backend.",
                code="platform_not_configured",
                details={"platform": platform.value},
            )
        if not self.cipher.available:
            raise PlatformUnavailableError(
                "TOKEN_ENCRYPTION_KEY is not set on the backend, so platform tokens cannot be stored securely.",
                code="encryption_not_configured",
            )
        return adapter.oauth

    async def _connection(self, user_id: int, platform: Platform) -> PlatformConnection | None:
        return await self.db.scalar(
            select(PlatformConnection).where(
                PlatformConnection.user_id == user_id, PlatformConnection.platform == platform.value
            )
        )

    # --- 1. start ---------------------------------------------------------------------
    async def start(self, user: User, platform: Platform) -> tuple[str, datetime]:
        provider = self._provider(platform)
        state = secrets.token_urlsafe(32)
        verifier, challenge = pkce_pair() if provider.uses_pkce else (None, None)
        expires_at = utcnow() + STATE_TTL
        # Only one pending authorization per user and platform.
        await self.db.execute(
            delete(OAuthState).where(OAuthState.user_id == user.id, OAuthState.platform == platform.value)
        )
        self.db.add(
            OAuthState(
                user_id=user.id,
                platform=platform.value,
                state_hash=hash_token(state),
                code_verifier_enc=self.cipher.encrypt(verifier) if verifier else None,
                expires_at=expires_at,
            )
        )
        await self.db.flush()
        return provider.authorization_url(state=state, code_challenge=challenge), expires_at

    # --- 2. callback ------------------------------------------------------------------
    async def complete(
        self, platform: Platform, *, state: str | None, code: str | None, error: str | None
    ) -> CallbackResult:
        """Never raises for user-facing failures: the state is consumed and the outcome recorded."""
        fail = lambda msg: CallbackResult(ok=False, platform=platform, message=msg)  # noqa: E731
        if not state:
            return fail("The authorization response is missing its state. Start again from StreamHunter.")
        pending = await self.db.scalar(select(OAuthState).where(OAuthState.state_hash == hash_token(state)))
        if pending is None or pending.platform != platform.value:
            return fail("This authorization link is not valid. Start again from StreamHunter.")
        if pending.used_at is not None or pending.expires_at <= utcnow():
            return fail("This authorization link expired or was already used. Start again from StreamHunter.")
        pending.used_at = utcnow()  # consume first: a replayed callback must fail
        await self.db.flush()

        conn = await self._connection(pending.user_id, platform)
        if conn is None:
            conn = PlatformConnection(user_id=pending.user_id, platform=platform.value, scopes=[])
            self.db.add(conn)

        if error or not code:
            conn.last_error = "Authorization was cancelled or denied on the platform."
            if conn.connection_status != ConnectionStatus.CONNECTED:
                conn.connection_status = ConnectionStatus.NOT_CONNECTED
            await self.db.flush()
            return fail("Authorization was cancelled or denied. Nothing was connected.")

        try:
            provider = self._provider(platform)
            verifier = self.cipher.decrypt(pending.code_verifier_enc) if pending.code_verifier_enc else None
            tokens = await provider.exchange_code(code, code_verifier=verifier)
            identity = await provider.identify(tokens.access_token)
        except AppError as exc:
            log.warning("oauth_exchange_failed", extra={"platform": platform.value, "code": exc.code})
            conn.connection_status = ConnectionStatus.ERROR
            conn.last_error = exc.message
            await self.db.flush()
            return fail(f"Could not complete the connection: {exc.message}")

        self._store_tokens(conn, tokens)
        conn.platform_user_id = identity.platform_user_id
        conn.platform_username = identity.username
        conn.connection_status = ConnectionStatus.CONNECTED
        conn.last_error = None
        await self.db.flush()
        log.info("platform_connected", extra={"platform": platform.value, "user_id": pending.user_id})
        return CallbackResult(ok=True, platform=platform, message="Connected.", username=identity.username)

    def _store_tokens(self, conn: PlatformConnection, tokens: TokenSet) -> None:
        conn.access_token_enc = self.cipher.encrypt(tokens.access_token)
        if tokens.refresh_token:
            conn.refresh_token_enc = self.cipher.encrypt(tokens.refresh_token)
        conn.token_expires_at = utcnow() + timedelta(seconds=tokens.expires_in) if tokens.expires_in else None
        conn.scopes = sorted(tokens.scopes)

    # --- status / disconnect ------------------------------------------------------------
    async def status(self, user: User, platform: Platform) -> PlatformConnection | None:
        return await self._connection(user.id, platform)

    async def disconnect(self, user: User, platform: Platform) -> None:
        conn = await self._connection(user.id, platform)
        if conn is None:
            return
        provider = self.registry.get(platform).oauth
        if provider is not None and self.cipher.available:
            for enc in (conn.access_token_enc, conn.refresh_token_enc):
                if enc:
                    try:
                        await provider.revoke(self.cipher.decrypt(enc))
                    except ValueError:
                        pass  # undecryptable (key rotated): just drop it
        conn.access_token_enc = None
        conn.refresh_token_enc = None
        conn.token_expires_at = None
        conn.scopes = []
        conn.connection_status = ConnectionStatus.NOT_CONNECTED
        conn.last_error = None
        await self.db.flush()

    # --- token access for later phases (chat, clips) --------------------------------------
    async def access_token(self, user: User, platform: Platform) -> str:
        conn = await self._connection(user.id, platform)
        if conn is None or conn.connection_status != ConnectionStatus.CONNECTED or not conn.access_token_enc:
            raise PlatformUnavailableError(
                f"Connect your {platform.value.title()} account first.", code="requires_authorization"
            )
        if conn.token_expires_at is None or conn.token_expires_at - REFRESH_MARGIN > utcnow():
            return self.cipher.decrypt(conn.access_token_enc)
        provider = self._provider(platform)
        if not conn.refresh_token_enc:
            conn.connection_status = ConnectionStatus.EXPIRED
            await self.db.flush()
            raise PlatformUnavailableError(f"Your {platform.value.title()} connection expired; reconnect it.", code="requires_authorization")
        try:
            tokens = await provider.refresh(self.cipher.decrypt(conn.refresh_token_enc))
        except AppError as exc:
            conn.connection_status = ConnectionStatus.EXPIRED
            conn.last_error = exc.message
            await self.db.flush()
            raise PlatformUnavailableError(
                f"Your {platform.value.title()} connection expired; reconnect it.", code="requires_authorization"
            ) from exc
        self._store_tokens(conn, tokens)
        await self.db.flush()
        return tokens.access_token
