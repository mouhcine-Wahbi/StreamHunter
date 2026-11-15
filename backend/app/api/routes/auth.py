from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status

from app.api.dependencies import AuthServiceDep, CurrentUser, SettingsDep, TokenDep, rate_limit_auth
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserOut
from app.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/api/v1/auth", tags=["auth"], responses=ERROR_RESPONSES)


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit_auth)],
    summary="Create an account and start a session",
)
async def register(body: RegisterRequest, request: Request, auth: AuthServiceDep, settings: SettingsDep) -> TokenResponse:
    user = await auth.register(body, allowed=settings.allow_registration)
    token, expires_at = await auth.create_session(user, request.headers.get("user-agent"))
    return TokenResponse(access_token=token, expires_at=expires_at, user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenResponse, dependencies=[Depends(rate_limit_auth)], summary="Start a session")
async def login(body: LoginRequest, request: Request, auth: AuthServiceDep) -> TokenResponse:
    user = await auth.login(body)
    token, expires_at = await auth.create_session(user, request.headers.get("user-agent"))
    return TokenResponse(access_token=token, expires_at=expires_at, user=UserOut.model_validate(user))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response, summary="Revoke the current session")
async def logout(token: TokenDep, auth: AuthServiceDep) -> None:
    await auth.authenticate(token)
    await auth.logout(token)


@router.get("/me", response_model=UserOut, summary="The signed-in user")
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)
