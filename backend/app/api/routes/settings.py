from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api.dependencies import SettingsServiceDep
from app.schemas.common import ERROR_RESPONSES
from app.schemas.settings import UserSettingsModel

router = APIRouter(prefix="/api/v1/settings", tags=["settings"], responses=ERROR_RESPONSES)


@router.get("", response_model=UserSettingsModel, summary="Your settings (defaults if never saved)")
async def get_settings(svc: SettingsServiceDep) -> UserSettingsModel:
    return await svc.get()


@router.patch("", response_model=UserSettingsModel, summary="Deep-merge a partial settings object")
async def patch_settings(
    svc: SettingsServiceDep,
    patch: dict[str, Any] = Body(..., examples=[{"detection": {"sensitivity": "high"}}]),
) -> UserSettingsModel:
    return await svc.patch(patch)
