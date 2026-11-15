"""StreamHunter API — application factory.

Run locally:  uvicorn app.main:app --reload   (from the backend/ directory)
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import activity, auth, health, platforms, streamers, streams
from app.api.routes import settings as settings_routes
from app.config import Settings, get_settings
from app.db.session import create_engine, create_sessionmaker
from app.errors import install_error_handlers
from app.integrations.registry import PlatformRegistry
from app.logging_config import configure_logging
from app.utils.crypto import TokenCipher
from app.utils.rate_limit import SlidingWindowLimiter

log = logging.getLogger("streamhunter")


def create_app(settings: Settings | None = None, registry: PlatformRegistry | None = None) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_for_runtime()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        log.info("startup", extra={"version": __version__, "env": settings.app_env})
        yield
        await app.state.registry.aclose()
        await app.state.engine.dispose()
        log.info("shutdown")

    app = FastAPI(
        title="StreamHunter API",
        version=__version__,
        description="Find the moment. Create the clip. Backend for the StreamHunter Chrome extension.",
        lifespan=lifespan,
    )

    engine = create_engine(settings.database_url)
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = create_sessionmaker(engine)
    app.state.registry = registry or PlatformRegistry.from_settings(settings)
    app.state.auth_limiter = SlidingWindowLimiter(settings.auth_rate_limit_per_minute, 60)
    app.state.token_cipher = TokenCipher(
        settings.token_encryption_key.get_secret_value() if settings.token_encryption_key else None
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        # Extension pages (chrome-extension://<id>) only need CORS when lacking host permission;
        # they are matched explicitly rather than with a wildcard.
        allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
        max_age=600,
    )
    install_error_handlers(app)

    for router in (
        health.router,
        auth.router,
        streamers.router,
        streams.router,
        activity.monitoring,
        activity.highlights,
        activity.clips,
        settings_routes.router,
        platforms.router,
    ):
        app.include_router(router)
    return app


def _default_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level)
    return create_app(s)


app = _default_app()
