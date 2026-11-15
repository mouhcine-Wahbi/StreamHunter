"""Background loop driving MonitoringEngine.run_cycle and the retention sweep.

Runs inside the API process (asyncio task started in the app lifespan). It only does work
for users holding an active browser lease, so with no extension open it is idle.
A Celery/Redis worker can replace it later behind the same engine API.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from app.monitoring.engine import MonitoringEngine
from app.monitoring.retention import sweep

log = logging.getLogger("streamhunter.scheduler")


class Scheduler:
    def __init__(self, engine: MonitoringEngine, *, tick_seconds: int, retention_seconds: int):
        self.engine = engine
        self.tick = tick_seconds
        self.retention_every = retention_seconds
        self._task: asyncio.Task[None] | None = None
        self._last_retention = 0.0

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="streamhunter-scheduler")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        log.info("scheduler_started", extra={"tick_seconds": self.tick})
        while True:
            try:
                await self.engine.run_cycle()
                if time.monotonic() - self._last_retention >= self.retention_every:
                    async with self.engine.maker() as db:
                        await sweep(db)
                        await db.commit()
                    self._last_retention = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception:  # never let one bad cycle kill monitoring
                log.exception("scheduler_cycle_failed")
            await asyncio.sleep(self.tick)
