"""Helix REST client using an app access token (client credentials)."""

from __future__ import annotations

from collections.abc import Iterable

import httpx
from pydantic import ValidationError

from app.errors import UpstreamError
from app.integrations.app_token import AppTokenCache
from app.integrations.http import PlatformAuthError, RequestSpec, json_body, send
from app.integrations.twitch.schemas import HelixList, HelixSearchChannel, HelixStream, HelixUser, TwitchTokenResponse

ID_URL = "https://id.twitch.tv/oauth2"
HELIX_URL = "https://api.twitch.tv/helix"
MAX_IDS_PER_REQUEST = 100  # Helix limit for user_id / login filters


def chunks[T](items: list[T], size: int) -> Iterable[list[T]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


class HelixClient:
    def __init__(self, client_id: str, client_secret: str, http: httpx.AsyncClient):
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self.app_token = AppTokenCache(self._fetch_app_token)

    async def _fetch_app_token(self) -> tuple[str, int | None]:
        resp = await send(
            self._http,
            RequestSpec(
                "twitch",
                "POST",
                f"{ID_URL}/token",
                data={"client_id": self._client_id, "client_secret": self._client_secret, "grant_type": "client_credentials"},
            ),
        )
        try:
            tok = TwitchTokenResponse.model_validate(json_body(resp, "twitch"))
        except ValidationError as exc:
            raise UpstreamError("Twitch returned an unexpected token response") from exc
        return tok.access_token, tok.expires_in

    async def _get(self, path: str, params: list[tuple[str, str | int]]) -> object:
        for attempt in (1, 2):
            token = await self.app_token.get()
            try:
                resp = await send(
                    self._http,
                    RequestSpec(
                        "twitch",
                        "GET",
                        f"{HELIX_URL}{path}",
                        params=params,
                        headers={"Authorization": f"Bearer {token}", "Client-Id": self._client_id},
                    ),
                )
                return json_body(resp, "twitch")
            except PlatformAuthError:
                # Token revoked/expired early: fetch a new one once, then give up.
                self.app_token.invalidate()
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    @staticmethod
    def _parse[T](model: type[T], body: object) -> list[T]:
        try:
            return HelixList[model].model_validate(body).data  # type: ignore[valid-type]
        except ValidationError as exc:
            raise UpstreamError("Twitch returned an unexpected response shape") from exc

    async def search_channels(self, query: str, first: int) -> list[HelixSearchChannel]:
        body = await self._get("/search/channels", [("query", query), ("first", first)])
        return self._parse(HelixSearchChannel, body)

    async def get_users(self, *, logins: list[str] = [], ids: list[str] = []) -> list[HelixUser]:  # noqa: B006
        params: list[tuple[str, str | int]] = [("login", x) for x in logins] + [("id", x) for x in ids]
        out: list[HelixUser] = []
        for batch in chunks(params, MAX_IDS_PER_REQUEST):
            out += self._parse(HelixUser, await self._get("/users", batch))
        return out

    async def get_streams(self, user_ids: list[str]) -> list[HelixStream]:
        out: list[HelixStream] = []
        for batch in chunks(user_ids, MAX_IDS_PER_REQUEST):
            params: list[tuple[str, str | int]] = [("user_id", x) for x in batch] + [("first", MAX_IDS_PER_REQUEST)]
            out += self._parse(HelixStream, await self._get("/streams", params))
        return out
