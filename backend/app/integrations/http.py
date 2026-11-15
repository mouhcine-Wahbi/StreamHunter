"""Shared HTTP plumbing for platform clients: timeouts, retries, rate limits, error mapping."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from app.errors import AppError, PlatformUnavailableError, UpstreamError

log = logging.getLogger("streamhunter.integrations")

DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


class PlatformAuthError(AppError):
    """The platform rejected our credentials (401/403)."""

    status_code = 502
    code = "platform_auth_failed"


class PlatformRateLimited(AppError):
    status_code = 503
    code = "platform_rate_limited"


def make_client(base_url: str = "", transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=base_url,
        timeout=DEFAULT_TIMEOUT,
        transport=transport,
        headers={"User-Agent": "StreamHunter/0.3 (+https://github.com/)"},
        follow_redirects=False,
    )


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    # Twitch: Ratelimit-Reset = epoch seconds. Generic: Retry-After = seconds.
    if (reset := resp.headers.get("Ratelimit-Reset")) and reset.isdigit():
        return max(0.0, int(reset) - time.time())
    if (ra := resp.headers.get("Retry-After")) and ra.replace(".", "", 1).isdigit():
        return float(ra)
    return None


@dataclass(slots=True)
class RequestSpec:
    platform: str
    method: str
    url: str
    params: Any = None
    headers: dict[str, str] | None = None
    data: dict[str, str] | None = None
    json: Any = None


async def send(
    client: httpx.AsyncClient,
    spec: RequestSpec,
    *,
    retries: int = 1,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> httpx.Response:
    """Sends a request; retries once on 5xx/network errors and once on a short rate-limit wait.

    Maps failures to explicit AppErrors so the API never returns half-parsed platform data.
    """
    attempt = 0
    while True:
        try:
            resp = await client.request(
                spec.method, spec.url, params=spec.params, headers=spec.headers, data=spec.data, json=spec.json
            )
        except httpx.TimeoutException as exc:
            if attempt < retries:
                attempt += 1
                await sleep(0.5 * attempt)
                continue
            raise PlatformUnavailableError(
                f"{spec.platform.title()} did not respond in time", code="platform_timeout"
            ) from exc
        except httpx.HTTPError as exc:
            if attempt < retries:
                attempt += 1
                await sleep(0.5 * attempt)
                continue
            raise PlatformUnavailableError(
                f"Could not reach {spec.platform.title()}", code="platform_unreachable"
            ) from exc

        if resp.status_code == 429:
            wait = _retry_after_seconds(resp)
            if attempt < retries and wait is not None and wait <= 5:
                attempt += 1
                await sleep(wait)
                continue
            raise PlatformRateLimited(f"{spec.platform.title()} rate limit reached; try again shortly")
        if resp.status_code >= 500 and attempt < retries:
            attempt += 1
            await sleep(0.5 * attempt)
            continue
        if resp.status_code >= 500:
            raise UpstreamError(f"{spec.platform.title()} returned an error ({resp.status_code})")
        if resp.status_code in (401, 403):
            raise PlatformAuthError(f"{spec.platform.title()} rejected the credentials ({resp.status_code})")
        if resp.status_code >= 400:
            # Never echo the full upstream body (could contain request details); log a short excerpt.
            log.warning(
                "platform_client_error",
                extra={"platform": spec.platform, "status": resp.status_code, "path": httpx.URL(spec.url).path},
            )
            raise UpstreamError(
                f"{spec.platform.title()} rejected the request ({resp.status_code})",
                details={"platform_status": resp.status_code},
            )
        return resp


def json_body(resp: httpx.Response, platform: str) -> Any:
    try:
        return resp.json()
    except ValueError as exc:
        raise UpstreamError(f"{platform.title()} returned invalid JSON") from exc
