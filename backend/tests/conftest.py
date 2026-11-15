from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

import app.models  # noqa: F401
from app.config import Settings
from app.db.base import Base
from app.domain.enums import Platform
from app.integrations.registry import PlatformRegistry
from app.main import create_app
from tests.fakes import FakePlatform, channel


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,  # never read a developer's real .env in tests
        app_env="test",
        scheduler_enabled=False,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'test.db'}",
        auth_rate_limit_per_minute=1000,
    )


@pytest.fixture
def fake_twitch() -> FakePlatform:
    return FakePlatform(
        Platform.TWITCH,
        [channel(Platform.TWITCH, "1001", "alpha", live=True), channel(Platform.TWITCH, "1002", "bravo")],
    )


@pytest.fixture
def fake_kick() -> FakePlatform:
    return FakePlatform(Platform.KICK, [channel(Platform.KICK, "2001", "alpha", live=False)])


@pytest.fixture
async def app(settings: Settings, fake_twitch: FakePlatform, fake_kick: FakePlatform) -> AsyncIterator[FastAPI]:
    registry = PlatformRegistry({Platform.TWITCH: fake_twitch, Platform.KICK: fake_kick})
    application = create_app(settings, registry=registry)
    async with application.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield application
    await application.state.engine.dispose()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def register(client: httpx.AsyncClient, email: str = "editor@example.com", password: str = "correct horse battery") -> dict:
    r = await client.post("/api/v1/auth/register", json={"email": email, "username": email.split("@")[0], "password": password})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
async def auth_headers(client: httpx.AsyncClient) -> dict[str, str]:
    body = await register(client)
    return {"Authorization": f"Bearer {body['access_token']}"}
