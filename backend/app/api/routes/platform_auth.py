"""Platform account connections: /api/v1/auth/{platform}/authorize|callback|status|disconnect."""

from __future__ import annotations

from html import escape
from typing import Annotated

from fastapi import APIRouter, Query, Response, status
from fastapi.responses import HTMLResponse

from app.api.dependencies import ConnectionServiceDep, CurrentUser, RegistryDep
from app.domain.enums import ConnectionStatus, Platform
from app.schemas.common import ERROR_RESPONSES
from app.schemas.platform import AuthorizeOut, ConnectionOut
from app.services.connection_service import CallbackResult

router = APIRouter(prefix="/api/v1/auth", tags=["platform connections"], responses=ERROR_RESPONSES)

# The callback page needs no scripts or external resources at all.
_PAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def _page(result: CallbackResult) -> HTMLResponse:
    title = "Connected" if result.ok else "Not connected"
    color = "#22c55e" if result.ok else "#f59e0b"
    who = f" as <strong>{escape(result.username)}</strong>" if result.ok and result.username else ""
    body = (
        f"{escape(result.platform.value.title())} is now connected{who}."
        if result.ok
        else escape(result.message)
    )
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamHunter · {title}</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f13;color:#eceef3;
font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}main{{max-width:420px;padding:32px;
border:1px solid #22252e;border-radius:14px;background:#13151a;text-align:center}}h1{{font-size:18px;margin:0 0 8px;
color:{color}}}p{{color:#a3a9b6;margin:0 0 6px}}</style></head><body><main><h1>{title}</h1><p>{body}</p>
<p>You can close this tab and return to StreamHunter.</p></main></body></html>"""
    return HTMLResponse(html, status_code=200 if result.ok else 400, headers=_PAGE_HEADERS)


@router.get("/{platform}/authorize", response_model=AuthorizeOut, summary="Start connecting a platform account")
async def authorize(platform: Platform, user: CurrentUser, svc: ConnectionServiceDep) -> AuthorizeOut:
    url, expires_at = await svc.start(user, platform)
    return AuthorizeOut(authorization_url=url, expires_at=expires_at)


@router.get(
    "/{platform}/callback",
    response_class=HTMLResponse,
    include_in_schema=True,
    summary="OAuth redirect target (opened by the platform, not called directly)",
)
async def callback(
    platform: Platform,
    svc: ConnectionServiceDep,
    code: Annotated[str | None, Query(max_length=512)] = None,
    state: Annotated[str | None, Query(max_length=256)] = None,
    error: Annotated[str | None, Query(max_length=256)] = None,
) -> HTMLResponse:
    return _page(await svc.complete(platform, state=state, code=code, error=error))


@router.get("/{platform}/status", response_model=ConnectionOut, summary="Connection state for a platform")
async def connection_status(
    platform: Platform, user: CurrentUser, svc: ConnectionServiceDep, registry: RegistryDep
) -> ConnectionOut:
    conn = await svc.status(user, platform)
    configured = registry.get(platform).configured
    if conn is None:
        return ConnectionOut(platform=platform, configured=configured, connection_status=ConnectionStatus.NOT_CONNECTED)
    return ConnectionOut(
        platform=platform,
        configured=configured,
        connection_status=ConnectionStatus(conn.connection_status),
        platform_user_id=conn.platform_user_id,
        platform_username=conn.platform_username,
        scopes=list(conn.scopes or []),
        token_expires_at=conn.token_expires_at,
        last_error=conn.last_error,
    )


@router.post(
    "/{platform}/disconnect",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
    summary="Revoke and delete the stored platform tokens",
)
async def disconnect(platform: Platform, user: CurrentUser, svc: ConnectionServiceDep) -> None:
    await svc.disconnect(user, platform)
