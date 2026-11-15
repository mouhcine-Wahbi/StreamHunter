"""Client-credentials (app access token) cache shared by both platforms."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass


@dataclass(slots=True)
class AppToken:
    value: str
    expires_at: float  # monotonic seconds


class AppTokenCache:
    """Fetches an app token lazily, reuses it until shortly before expiry, and lets
    callers invalidate it after a 401. Concurrent callers share one fetch."""

    def __init__(
        self,
        fetch: Callable[[], Awaitable[tuple[str, int | None]]],
        *,
        clock: Callable[[], float] = time.monotonic,
        margin_seconds: int = 300,
        default_ttl: int = 3600,
    ):
        self._fetch = fetch
        self._clock = clock
        self._margin = margin_seconds
        self._default_ttl = default_ttl
        self._token: AppToken | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> str:
        if self._token and self._token.expires_at - self._margin > self._clock():
            return self._token.value
        async with self._lock:
            if self._token and self._token.expires_at - self._margin > self._clock():
                return self._token.value
            value, expires_in = await self._fetch()
            ttl = expires_in if expires_in and expires_in > 0 else self._default_ttl
            self._token = AppToken(value=value, expires_at=self._clock() + ttl)
            return value

    def invalidate(self) -> None:
        self._token = None
