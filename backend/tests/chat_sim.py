"""Deterministic chat simulator for detection tests (seeded, no wall clock)."""

from __future__ import annotations

import random
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

from app.detection.models import ChatMessage
from app.domain.enums import Platform

T0 = datetime(2026, 11, 15, 12, 0, 0, tzinfo=UTC)
FILLER = ["hi chat", "what game is this", "nice", "how long is stream", "first time here", "ok",
          "this music is good", "anyone else lagging", "gm", "true", "lmk when he plays ranked", "yo"]


class ChatSim:
    def __init__(self, seed: int = 7, chatters: int = 120, platform: Platform = Platform.TWITCH):
        self.rng = random.Random(seed)
        self.users = [f"u{i}" for i in range(chatters)]
        self.platform = platform
        self.now = T0

    def msg(self, user: str, text: str, emotes: tuple[str, ...] = (), at: datetime | None = None) -> ChatMessage:
        return ChatMessage(self.platform, "b1", user, user, text, emotes, at or self.now)

    def normal(self, seconds: int, per_5s: float = 4.0) -> Iterator[ChatMessage]:
        """Background chatter at roughly `per_5s` messages per bucket."""
        for step in range(seconds):
            t = self.now + timedelta(seconds=step)
            k = self.rng.random()
            n = int(per_5s / 5) + (1 if k < (per_5s / 5) % 1 else 0)
            for _ in range(n):
                yield self.msg(self.rng.choice(self.users), self.rng.choice(FILLER), at=t)
        self.now += timedelta(seconds=seconds)

    def burst(self, seconds: int, users: int, text: str, emotes: tuple[str, ...] = (), per_user: int = 1) -> Iterator[ChatMessage]:
        crowd = self.rng.sample(self.users, users)
        for i, u in enumerate(crowd):
            t = self.now + timedelta(seconds=(i * seconds) / users)
            for _ in range(per_user):
                yield self.msg(u, text, emotes, at=t)
        self.now += timedelta(seconds=seconds)

    def spam(self, seconds: int, user: str, text: str, per_second: int = 5) -> Iterator[ChatMessage]:
        for s in range(seconds):
            for _ in range(per_second):
                yield self.msg(user, text, at=self.now + timedelta(seconds=s))
        self.now += timedelta(seconds=seconds)
