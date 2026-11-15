from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db.session import session_scope
from app.domain.enums import Platform
from app.errors import AuthError, RateLimitedError
from app.integrations.base import StreamingPlatform
from app.integrations.registry import PlatformRegistry
from app.models import User
from app.schemas.common import PageParams
from app.services.activity_service import ActivityService
from app.services.auth_service import AuthService
from app.services.settings_service import SettingsService
from app.services.streamer_service import StreamerService
from app.utils.rate_limit import SlidingWindowLimiter


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in session_scope(request.app.state.sessionmaker):
        yield session


def get_registry(request: Request) -> PlatformRegistry:
    return request.app.state.registry  # type: ignore[no-any-return]


SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
DbDep = Annotated[AsyncSession, Depends(get_db)]
RegistryDep = Annotated[PlatformRegistry, Depends(get_registry)]

_bearer = HTTPBearer(auto_error=False, description="StreamHunter session token from /api/v1/auth/login")


def get_auth_service(db: DbDep, settings: SettingsDep) -> AuthService:
    return AuthService(db, timedelta(hours=settings.session_ttl_hours))


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]


def bearer_token(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]) -> str:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise AuthError("Authentication required")
    return creds.credentials


TokenDep = Annotated[str, Depends(bearer_token)]


async def current_user(token: TokenDep, auth: AuthServiceDep) -> User:
    return await auth.authenticate(token)


CurrentUser = Annotated[User, Depends(current_user)]


def rate_limit_auth(request: Request) -> None:
    limiter: SlidingWindowLimiter = request.app.state.auth_limiter
    client = request.client.host if request.client else "unknown"
    if not limiter.hit(f"{client}:{request.url.path}"):
        raise RateLimitedError("Too many attempts. Try again in a minute.")


def page_params(
    limit: Annotated[int, Query(ge=1, le=100)] = 50, offset: Annotated[int, Query(ge=0)] = 0
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


PageDep = Annotated[PageParams, Depends(page_params)]


def streamer_service(db: DbDep, user: CurrentUser) -> StreamerService:
    return StreamerService(db, user)


def activity_service(db: DbDep, user: CurrentUser) -> ActivityService:
    return ActivityService(db, user)


def settings_service(db: DbDep, user: CurrentUser) -> SettingsService:
    return SettingsService(db, user)


StreamerServiceDep = Annotated[StreamerService, Depends(streamer_service)]
ActivityServiceDep = Annotated[ActivityService, Depends(activity_service)]
SettingsServiceDep = Annotated[SettingsService, Depends(settings_service)]


def adapter_for(registry: PlatformRegistry, platform: Platform) -> StreamingPlatform:
    return registry.get(platform)
