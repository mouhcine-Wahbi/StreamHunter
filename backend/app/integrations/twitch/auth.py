"""Twitch user authorization: OAuth authorization-code flow (confidential client).

Twitch's code flow requires the client secret, so the exchange happens only here.
Twitch requires apps to validate user tokens periodically; `identify` uses /validate.
"""

from __future__ import annotations

from urllib.parse import urlencode

import httpx
from pydantic import ValidationError

from app.errors import UpstreamError
from app.integrations.base import OAuthProvider, PlatformIdentity, TokenSet
from app.integrations.http import RequestSpec, json_body, send
from app.integrations.twitch.client import ID_URL
from app.integrations.twitch.schemas import TwitchTokenResponse, TwitchValidateResponse

# user:read:chat → EventSub channel.chat.message (Phase 5); clips:edit → Create Clip (Phase 6).
TWITCH_SCOPES: tuple[str, ...] = ("user:read:chat", "clips:edit")


def _token_set(body: object) -> TokenSet:
    try:
        t = TwitchTokenResponse.model_validate(body)
    except ValidationError as exc:
        raise UpstreamError("Twitch returned an unexpected token response") from exc
    scopes = t.scope.split() if isinstance(t.scope, str) else (t.scope or [])
    return TokenSet(t.access_token, t.refresh_token, t.expires_in, frozenset(scopes))


class TwitchOAuth(OAuthProvider):
    scopes = TWITCH_SCOPES
    uses_pkce = False

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, http: httpx.AsyncClient):
        self._id = client_id
        self._secret = client_secret
        self._redirect = redirect_uri
        self._http = http

    def authorization_url(self, *, state: str, code_challenge: str | None) -> str:
        q = {
            "client_id": self._id,
            "redirect_uri": self._redirect,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "state": state,
            "force_verify": "true",  # always show the consent screen so the user sees the scopes
        }
        return f"{ID_URL}/authorize?{urlencode(q)}"

    async def _token(self, data: dict[str, str]) -> TokenSet:
        resp = await send(
            self._http,
            RequestSpec("twitch", "POST", f"{ID_URL}/token", data={"client_id": self._id, "client_secret": self._secret, **data}),
            retries=0,  # codes are single use; never replay
        )
        return _token_set(json_body(resp, "twitch"))

    async def exchange_code(self, code: str, *, code_verifier: str | None) -> TokenSet:
        return await self._token({"code": code, "grant_type": "authorization_code", "redirect_uri": self._redirect})

    async def refresh(self, refresh_token: str) -> TokenSet:
        return await self._token({"grant_type": "refresh_token", "refresh_token": refresh_token})

    async def identify(self, access_token: str) -> PlatformIdentity:
        resp = await send(
            self._http, RequestSpec("twitch", "GET", f"{ID_URL}/validate", headers={"Authorization": f"OAuth {access_token}"})
        )
        try:
            v = TwitchValidateResponse.model_validate(json_body(resp, "twitch"))
        except ValidationError as exc:
            raise UpstreamError("Twitch returned an unexpected validate response") from exc
        if v.client_id != self._id or not v.user_id:
            raise UpstreamError("Twitch token does not belong to this application or user")
        return PlatformIdentity(platform_user_id=v.user_id, username=v.login or v.user_id)

    async def revoke(self, token: str) -> None:
        try:
            await self._http.post(f"{ID_URL}/revoke", data={"client_id": self._id, "token": token})
        except httpx.HTTPError:
            pass  # best effort: the stored copy is deleted regardless
