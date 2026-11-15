from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError
from app.models import User, UserSettings
from app.schemas.settings import UserSettingsModel


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in patch.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


class SettingsService:
    def __init__(self, db: AsyncSession, user: User):
        self.db = db
        self.user = user

    async def _row(self) -> UserSettings | None:
        return await self.db.scalar(select(UserSettings).where(UserSettings.user_id == self.user.id))

    async def get(self) -> UserSettingsModel:
        row = await self._row()
        if row is None:
            return UserSettingsModel()
        try:
            return UserSettingsModel.model_validate(row.settings)
        except ValidationError:
            # Stored data from an older schema: fall back to defaults merged with what is still valid.
            return UserSettingsModel()

    async def patch(self, patch: dict[str, Any]) -> UserSettingsModel:
        current = (await self.get()).model_dump()
        try:
            merged = UserSettingsModel.model_validate(deep_merge(current, patch))
        except ValidationError as exc:
            raise AppError(
                "Invalid settings",
                code="validation_error",
                details={"errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]},
            ) from exc
        row = await self._row()
        if row is None:
            row = UserSettings(user_id=self.user.id, settings={})
            self.db.add(row)
        row.settings = merged.model_dump()
        await self.db.flush()
        return merged
