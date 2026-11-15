"""Small in-process sliding-window rate limiter.

Adequate for a single backend process (the MVP). A multi-instance deployment should
replace it with a shared store (e.g. Redis) behind the same interface.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> bool:
        """Records an attempt; returns False when the key is over its limit."""
        now = self._clock()
        q = self._hits.setdefault(key, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        if len(self._hits) > 10_000:  # bound memory under key-spraying
            self._hits = {k: v for k, v in self._hits.items() if v and v[-1] > now - self.window}
        return True

    def reset(self) -> None:
        self._hits.clear()
