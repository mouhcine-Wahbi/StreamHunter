from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

import app.models  # noqa: F401  (registers all tables on Base.metadata)
from app.config import get_settings
from app.db.base import Base
from app.db.session import create_engine

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    # Tests (and tooling) can pass an explicit URL; otherwise use the app settings.
    return config.attributes.get("database_url") or get_settings().database_url


def _configure(connection: Connection | None = None, url: str | None = None) -> None:
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        literal_binds=connection is None,
        compare_type=True,
        # SQLite cannot ALTER most things; batch mode rebuilds tables when needed.
        render_as_batch=True,
    )


def run_migrations_offline() -> None:
    _configure(url=_database_url())
    with context.begin_transaction():
        context.run_migrations()


def _run_sync(connection: Connection) -> None:
    _configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_engine(_database_url())
    async with engine.connect() as connection:
        await connection.run_sync(_run_sync)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
