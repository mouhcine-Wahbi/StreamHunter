from __future__ import annotations

from pydantic import BaseModel

from app.domain.enums import ConnectionStatus, Platform
from app.integrations.base import CapabilityReport, CapabilityState


class CapabilityReportOut(BaseModel):
    platform: Platform
    configured: bool
    connection_status: ConnectionStatus
    capabilities: dict[str, CapabilityState]
    notes: list[str]

    @classmethod
    def from_report(cls, r: CapabilityReport) -> CapabilityReportOut:
        return cls(
            platform=r.platform,
            configured=r.configured,
            connection_status=r.connection_status,
            capabilities=dict(r.capabilities),
            notes=list(r.notes),
        )
