"""Kick user authorization: OAuth 2.1 authorization code + PKCE (S256).

Verified against KickEngineering/KickDevDocs: state and PKCE are required, and the token
exchange and refresh both require the client secret (so they happen only on the backend).
"""

from __future__ import annotations

from urllib.parse import urlencode

import httpx
from pydantic import ValidationError

from app.errors import UpstreamError
from app.integrations.base import OAuthProvider, PlatformIdentity, TokenSet
from app.integrations.http import RequestSpec, json_body, send
from app.integrations.kick.client import ID_URL, KickApiClient
from app.integrations.kick.schemas import KickTokenResponse

# user:read → identify the account; channel:read → channel data; events:subscribe → chat webhooks (Phase 5).
KICK_SCOPES: tuple[str, ...] = ("user:read", "channel:read", "events:subscribe")


def _token_set(body: object) -> TokenSet:
    try:
        t = KickTokenResponse.model_validate(body)
    except ValidationError as exc:
        raise UpstreamError("Kick returned an unexpected token response") from exc
    scopes = t.scope.split() if isinstance(t.scope, str) else (t.scope or [])
    return TokenSet(t.access_token, t.refresh_token, t.expires_in, frozenset(scopes))


class KickOAuth(OAuthProvider):
    scopes = KICK_SCOPES
    uses_pkce = True

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, http: httpx.AsyncClient, api: KickApiClient):
        self._id = client_id
        self._secret = client_secret
        self._redirect = redirect_uri
        self._http = http
        self._api = api

    def authorization_url(self, *, state: str, code_challenge: str | None) -> str:
        if not code_challenge:
            raise ValueError("Kick requires PKCE")
        q = {
            "response_type": "code",
            "client_id": self._id,
            "redirect_uri": self._redirect,
            "scope": " ".join(self.scopes),
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return f"{ID_URL}/oauth/authorize?{urlencode(q)}"

    async def _token(self, data: dict[str, str]) -> TokenSet:
        resp = await send(
            self._http,
            RequestSpec("kick", "POST", f"{ID_URL}/oauth/token", data={"client_id": self._id, "client_secret": self._secret, **data}),
            retries=0,
        )
        return _token_set(json_body(resp, "kick"))

    async def exchange_code(self, code: str, *, code_verifier: str | None) -> TokenSet:
        if not code_verifier:
            raise ValueError("Kick requires the PKCE code_verifier")
        return await self._token(
            {"grant_type": "authorization_code", "code": code, "redirect_uri": self._redirect, "code_verifier": code_verifier}
        )

    async def refresh(self, refresh_token: str) -> TokenSet:
        return await self._token({"grant_type": "refresh_token", "refresh_token": refresh_token})

    async def identify(self, access_token: str) -> PlatformIdentity:
        user = await self._api.current_user(access_token)
        if user is None:
            raise UpstreamError("Kick did not return the authorized user")
        return PlatformIdentity(platform_user_id=user.user_id, username=user.name or user.user_id)

    async def revoke(self, token: str) -> None:
        try:
            await self._http.post(f"{ID_URL}/oauth/revoke", params={"token": token, "token_hint_type": "access_token"})
        except httpx.HTTPError:
            pass
