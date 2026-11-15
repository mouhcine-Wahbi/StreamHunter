"""Helpers to derive capability states from configuration + connection + build status."""

from __future__ import annotations

from app.domain.enums import ConnectionStatus
from app.integrations.base import CapabilityState as C
from app.integrations.base import UserConnectionState


def api_capability(*, configured: bool, implemented: bool) -> C:
    """A capability that only needs the backend's app credentials."""
    if not configured:
        return C.REQUIRES_CONFIGURATION
    return C.SUPPORTED if implemented else C.NOT_IMPLEMENTED


def user_capability(
    *, configured: bool, implemented: bool, connection: UserConnectionState, required_scopes: frozenset[str]
) -> C:
    """A capability that needs the user's OAuth authorization with specific scopes."""
    if not configured:
        return C.REQUIRES_CONFIGURATION
    if not implemented:
        return C.NOT_IMPLEMENTED
    if connection.status != ConnectionStatus.CONNECTED or not required_scopes <= connection.scopes:
        return C.REQUIRES_AUTHORIZATION
    return C.SUPPORTED
