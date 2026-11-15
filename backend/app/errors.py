"""Application errors and the consistent JSON error envelope.

Every error response has the shape:
    {"error": {"code": "<machine_code>", "message": "<human text>", "details": {...} | null}}
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("streamhunter.errors")


class AppError(Exception):
    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class AuthError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "not_authenticated"


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"


class RateLimitedError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"


class InvalidTransitionError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "invalid_status_transition"


class PlatformUnavailableError(AppError):
    """A platform feature cannot be used right now (not configured, not authorized, unsupported)."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "platform_unavailable"


class PlatformNotImplementedError(AppError):
    status_code = status.HTTP_501_NOT_IMPLEMENTED
    code = "not_implemented"


class UpstreamError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = "upstream_error"


def _body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status_code, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()
        ]
        return JSONResponse(
            _body("validation_error", "Request validation failed", {"errors": jsonable_encoder(errors)}),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(_body(code, str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_error", extra={"path": request.url.path})
        return JSONResponse(_body("internal_error", "Internal server error"), status_code=500)
