from __future__ import annotations

from datetime import datetime

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


class AuthorizeOut(BaseModel):
    authorization_url: str
    expires_at: datetime


class ConnectionOut(BaseModel):
    platform: Platform
    configured: bool
    connection_status: ConnectionStatus
    platform_user_id: str | None = None
    platform_username: str | None = None
    scopes: list[str] = []
    token_expires_at: datetime | None = None
    last_error: str | None = None


class RefreshOut(BaseModel):
    checked: int
    live: int
    skipped_recent: int
    unavailable: dict[str, str]
