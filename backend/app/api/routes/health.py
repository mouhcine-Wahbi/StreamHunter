from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel
from sqlalchemy import text

from app import __version__
from app.api.dependencies import DbDep, SettingsDep

router = APIRouter(tags=["health"])


class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    environment: str
    database: Literal["ok", "error"]


async def _health(db: DbDep, settings: SettingsDep, response: Response) -> HealthOut:
    try:
        await db.execute(text("SELECT 1"))
        db_state: Literal["ok", "error"] = "ok"
    except Exception:  # noqa: BLE001 - health must report, not raise
        db_state = "error"
    if db_state != "ok":
        response.status_code = 503
    return HealthOut(
        status="ok" if db_state == "ok" else "degraded",
        version=__version__,
        environment=settings.app_env,
        database=db_state,
    )


router.add_api_route("/health", _health, methods=["GET"], response_model=HealthOut, summary="Liveness and DB check")
router.add_api_route(
    "/api/v1/health", _health, methods=["GET"], response_model=HealthOut, summary="Liveness and DB check (versioned)"
)
