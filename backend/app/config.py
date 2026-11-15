"""Application configuration, loaded from environment variables / backend/.env."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    log_level: str = "INFO"

    database_url: str = "sqlite+aiosqlite:///./streamhunter.db"

    # Exact origins allowed by CORS. Extension pages with host permissions do not need
    # CORS; this is for the browser preview (http://localhost:5173) and other tools.
    cors_allowed_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    # --- Security ---
    token_encryption_key: SecretStr | None = None
    session_ttl_hours: int = Field(default=24 * 14, ge=1, le=24 * 90)
    allow_registration: bool = True
    auth_rate_limit_per_minute: int = Field(default=10, ge=1)

    # --- Monitoring (Phase 4) ---
    monitoring_lease_ttl_seconds: int = Field(default=360, ge=60)

    # --- Platforms (credentials only ever live here, never in the extension) ---
    twitch_client_id: str | None = None
    twitch_client_secret: SecretStr | None = None
    twitch_redirect_uri: str = "http://localhost:8000/api/v1/auth/twitch/callback"

    kick_client_id: str | None = None
    kick_client_secret: SecretStr | None = None
    kick_redirect_uri: str = "http://localhost:8000/api/v1/auth/kick/callback"
    kick_webhook_public_url: str | None = None

    @field_validator("database_url")
    @classmethod
    def _async_driver(cls, v: str) -> str:
        # Accept the familiar sync URLs and switch them to the async drivers we ship.
        if v.startswith("sqlite:///"):
            return v.replace("sqlite:///", "sqlite+aiosqlite:///", 1)
        if v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @field_validator("twitch_client_id", "kick_client_id", "kick_webhook_public_url", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    def validate_for_runtime(self) -> None:
        """Fail fast on configurations that are unsafe outside development."""
        if self.is_production:
            if self.token_encryption_key is None:
                raise RuntimeError("TOKEN_ENCRYPTION_KEY is required in production")
            if self.database_url.startswith("sqlite"):
                raise RuntimeError("Use PostgreSQL in production (DATABASE_URL)")


@lru_cache
def get_settings() -> Settings:
    return Settings()
