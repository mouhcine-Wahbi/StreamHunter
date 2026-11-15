from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbDep, RegistryDep
from app.domain.enums import ConnectionStatus
from app.integrations.base import UserConnectionState
from app.models import PlatformConnection
from app.schemas.common import ERROR_RESPONSES
from app.schemas.platform import CapabilityReportOut

router = APIRouter(prefix="/api/v1/platforms", tags=["platforms"], responses=ERROR_RESPONSES)


@router.get(
    "/capabilities",
    response_model=list[CapabilityReportOut],
    summary="What each platform can do for you right now",
)
async def capabilities(user: CurrentUser, db: DbDep, registry: RegistryDep) -> list[CapabilityReportOut]:
    rows = (await db.scalars(select(PlatformConnection).where(PlatformConnection.user_id == user.id))).all()
    by_platform = {r.platform: r for r in rows}
    out = []
    for adapter in registry.all():
        conn = by_platform.get(adapter.platform.value)
        state = (
            UserConnectionState(status=ConnectionStatus(conn.connection_status), scopes=frozenset(conn.scopes or []))
            if conn
            else UserConnectionState()
        )
        out.append(CapabilityReportOut.from_report(adapter.capabilities(state)))
    return out
