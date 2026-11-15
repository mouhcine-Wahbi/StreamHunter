"""Kick public API client using an app access token (client credentials)."""

from __future__ import annotations

import httpx
from pydantic import ValidationError

from app.errors import UpstreamError
from app.integrations.app_token import AppTokenCache
from app.integrations.http import PlatformAuthError, RequestSpec, json_body, send
from app.integrations.kick.schemas import KickChannel, KickList, KickTokenResponse, KickUser
from app.integrations.twitch.client import chunks

ID_URL = "https://id.kick.com"
API_URL = "https://api.kick.com/public/v1"
# Conservative batch size for repeated filters (exact limit not verified).
MAX_FILTER_VALUES = 50


class KickApiClient:
    def __init__(self, client_id: str, client_secret: str, http: httpx.AsyncClient):
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self.app_token = AppTokenCache(self._fetch_app_token)

    async def _fetch_app_token(self) -> tuple[str, int | None]:
        resp = await send(
            self._http,
            RequestSpec(
                "kick",
                "POST",
                f"{ID_URL}/oauth/token",
                data={"client_id": self._client_id, "client_secret": self._client_secret, "grant_type": "client_credentials"},
            ),
        )
        try:
            tok = KickTokenResponse.model_validate(json_body(resp, "kick"))
        except ValidationError as exc:
            raise UpstreamError("Kick returned an unexpected token response") from exc
        return tok.access_token, tok.expires_in

    async def get(self, path: str, params: list[tuple[str, str]], *, token: str | None = None) -> object:
        """GET with the app token (or a given user token)."""
        for attempt in (1, 2):
            bearer = token or await self.app_token.get()
            try:
                resp = await send(
                    self._http,
                    RequestSpec("kick", "GET", f"{API_URL}{path}", params=params, headers={"Authorization": f"Bearer {bearer}"}),
                )
                return json_body(resp, "kick")
            except PlatformAuthError:
                if token is not None or attempt == 2:
                    raise
                self.app_token.invalidate()
        raise AssertionError("unreachable")

    @staticmethod
    def _parse[T](model: type[T], body: object) -> list[T]:
        try:
            return KickList[model].model_validate(body).data  # type: ignore[valid-type]
        except ValidationError as exc:
            raise UpstreamError("Kick returned an unexpected response shape") from exc

    async def channels_by_slug(self, slug: str) -> list[KickChannel]:
        return self._parse(KickChannel, await self.get("/channels", [("slug", slug)]))

    async def channels_by_ids(self, broadcaster_user_ids: list[str]) -> list[KickChannel]:
        out: list[KickChannel] = []
        for batch in chunks(broadcaster_user_ids, MAX_FILTER_VALUES):
            body = await self.get("/channels", [("broadcaster_user_id", x) for x in batch])
            out += self._parse(KickChannel, body)
        return out

    async def users(self, ids: list[str]) -> list[KickUser]:
        out: list[KickUser] = []
        for batch in chunks(ids, MAX_FILTER_VALUES):
            out += self._parse(KickUser, await self.get("/users", [("id", x) for x in batch]))
        return out

    async def current_user(self, user_token: str) -> KickUser | None:
        """GET /users without filters returns the token's own user."""
        users = self._parse(KickUser, await self.get("/users", [], token=user_token))
        return users[0] if users else None
