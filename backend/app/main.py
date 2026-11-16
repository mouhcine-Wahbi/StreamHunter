"""StreamHunter API — application factory.

Run locally:  uvicorn app.main:app --reload   (from the backend/ directory)
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import auth, clips, health, highlights, media, monitoring, platform_auth, platforms, streamers, streams, webhooks
from app.api.routes import settings as settings_routes
from app.config import Settings, get_settings
from app.db.session import create_engine, create_sessionmaker
from app.errors import install_error_handlers
from app.integrations.registry import PlatformRegistry
from app.logging_config import configure_logging
from app.clipping.jobs import MediaJobRunner
from app.clipping.media_access import MediaLibrary, find_tool
from app.clipping.subtitles import WhisperTranscriber
from app.clipping.worker import ClipWorker
from app.monitoring.chat_manager import ChatManager
from app.monitoring.engine import MonitoringEngine
from app.monitoring.scheduler import Scheduler
from app.utils.crypto import TokenCipher
from app.utils.rate_limit import SlidingWindowLimiter

log = logging.getLogger("streamhunter")


def create_app(settings: Settings | None = None, registry: PlatformRegistry | None = None) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_for_runtime()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        log.info("startup", extra={"version": __version__, "env": settings.app_env})
        if settings.scheduler_enabled:
            app.state.scheduler = Scheduler(
                app.state.monitoring,
                tick_seconds=settings.scheduler_tick_seconds,
                retention_seconds=settings.retention_sweep_seconds,
            )
            app.state.scheduler.start()
            app.state.chat.start()
        yield
        if getattr(app.state, "scheduler", None):
            await app.state.scheduler.stop()
        await app.state.chat.stop()
        await app.state.clip_worker.stop()
        await app.state.media_jobs.stop()
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
    app.state.monitoring = MonitoringEngine(app.state.sessionmaker, app.state.registry, settings)
    app.state.scheduler = None
    app.state.auth_limiter = SlidingWindowLimiter(settings.auth_rate_limit_per_minute, 60)
    app.state.token_cipher = TokenCipher(
        settings.token_encryption_key.get_secret_value() if settings.token_encryption_key else None
    )
    app.state.chat = ChatManager(app.state.sessionmaker, app.state.registry, app.state.token_cipher)
    app.state.monitoring.chat = app.state.chat
    app.state.clip_worker = ClipWorker(app.state.sessionmaker, app.state.registry, app.state.token_cipher)
    app.state.chat.clip_worker = app.state.clip_worker
    app.state.media_library = MediaLibrary(settings.media_root, ffmpeg=find_tool(settings.ffmpeg_path, "ffmpeg"),
                                           ffprobe=find_tool(settings.ffprobe_path, "ffprobe"))
    transcriber = WhisperTranscriber(settings.whisper_model,
                                     settings.whisper_model_dir or Path(settings.media_root) / "models")
    app.state.media_jobs = MediaJobRunner(app.state.sessionmaker, app.state.media_library, settings, transcriber)
    app.state.kick_verifier = None  # created on first webhook (needs Kick credentials)

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
        platform_auth.router,
        streamers.router,
        streams.router,
        monitoring.router,
        highlights.router,
        clips.router,
        settings_routes.router,
        platforms.router,
        webhooks.router,
        media.router,
    ):
        app.include_router(router)
    return app


def _default_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level)
    return create_app(s)


app = _default_app()
