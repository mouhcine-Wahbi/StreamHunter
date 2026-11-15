"""Rolling chat window: 5-second buckets, per-user caps, per-stream baseline.

Only aggregates are kept (counters keyed by user id / emote / short normalized phrase),
and only for the last BASELINE_SECONDS. Message text is never stored beyond that and
never persisted.
"""

from __future__ import annotations

import math
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.detection import lexicon
from app.detection.models import ChatMessage

BUCKET_SECONDS = 5
WINDOW_BUCKETS = 3  # analysis window = 15 s
BASELINE_SECONDS = 300  # 5 min of history defines "normal" for this stream
MIN_BASELINE_BUCKETS = 6  # need ≥ 30 s of history before relative detection
PER_USER_CAP = 2  # messages per user per bucket that count (anti-spam)
MAX_PHRASE_CHARS = 40


@dataclass(slots=True)
class Bucket:
    start: datetime
    raw_messages: int = 0
    user_messages: Counter[str] = field(default_factory=Counter)
    emote_users: dict[str, set[str]] = field(default_factory=dict)
    phrase_users: dict[str, set[str]] = field(default_factory=dict)
    reaction_users: dict[str, set[str]] = field(default_factory=dict)
    clip_users: set[str] = field(default_factory=set)
    ignored: int = 0  # bots, commands, broadcaster

    @property
    def effective(self) -> int:
        return sum(min(c, PER_USER_CAP) for c in self.user_messages.values())


@dataclass(slots=True)
class WindowFeatures:
    start: datetime
    end: datetime
    effective_messages: int
    raw_messages: int
    unique_users: int
    emote_users: dict[str, int]
    phrase_users: dict[str, int]
    phrase_categories: dict[str, str | None]  # reaction category of each repeated phrase, if any
    reaction_users: dict[str, int]
    clip_requesters: int
    sentiment: float | None  # -1..1 over reacting users, None if nobody reacted


@dataclass(slots=True)
class Baseline:
    buckets: int
    mean: float  # effective messages per bucket
    std: float
    per_window_emote_users: dict[str, float]
    per_window_phrase_users: dict[str, float]
    per_window_reaction_users: dict[str, float]
    sentiment_mean: float | None

    @property
    def ready(self) -> bool:
        return self.buckets >= MIN_BASELINE_BUCKETS


def _floor(ts: datetime) -> datetime:
    epoch = int(ts.timestamp())
    return datetime.fromtimestamp(epoch - epoch % BUCKET_SECONDS, ts.tzinfo)


def _sentiment(reactions: dict[str, set[str]] | dict[str, int]) -> float | None:
    def size(v: set[str] | int) -> int:
        return v if isinstance(v, int) else len(v)

    pos = sum(size(v) for k, v in reactions.items() if k in lexicon.POSITIVE)
    neg = sum(size(v) for k, v in reactions.items() if k in lexicon.NEGATIVE)
    return None if pos + neg == 0 else (pos - neg) / (pos + neg)


class RollingChatWindow:
    def __init__(self, broadcaster_login: str | None = None):
        self.buckets: deque[Bucket] = deque()
        self.broadcaster_login = (broadcaster_login or "").lower()
        self.reaction_index: dict[str, str] = lexicon.build_reaction_index({"en"}, set())
        self.total_seen = 0
        self._phrase_category: dict[str, str | None] = {}

    def configure(self, languages: set[str], custom_keywords: set[str]) -> None:
        self.reaction_index = lexicon.build_reaction_index(languages, custom_keywords)
        self._phrase_category.clear()

    def _bucket_for(self, ts: datetime) -> Bucket:
        start = _floor(ts)
        if self.buckets and self.buckets[-1].start == start:
            return self.buckets[-1]
        if self.buckets and start < self.buckets[-1].start:
            # Late message (clock skew / delivery delay): count it in the newest bucket.
            return self.buckets[-1]
        b = Bucket(start=start)
        self.buckets.append(b)
        return b

    def add(self, msg: ChatMessage) -> None:
        self.total_seen += 1
        b = self._bucket_for(msg.received_at)
        b.raw_messages += 1
        login = msg.user_login.lower()
        if login in lexicon.KNOWN_BOTS or login == self.broadcaster_login or lexicon.is_command(msg.text):
            b.ignored += 1
            return
        uid = msg.user_id
        b.user_messages[uid] += 1
        if b.user_messages[uid] > PER_USER_CAP:
            return  # spam beyond the cap adds nothing further

        for e in set(msg.emotes):
            b.emote_users.setdefault(e, set()).add(uid)
        norm = lexicon.normalize(msg.text)
        if not norm:
            return
        cats = lexicon.match_reactions(norm, self.reaction_index)
        if lexicon.has_interrobang(msg.text):
            cats.add("shock")
        if len(norm) <= MAX_PHRASE_CHARS:
            b.phrase_users.setdefault(norm, set()).add(uid)
            if norm not in self._phrase_category and len(self._phrase_category) < 5000:
                self._phrase_category[norm] = min(cats) if cats else None
        if lexicon.is_clip_request(norm):
            b.clip_users.add(uid)
        for cat in cats:
            b.reaction_users.setdefault(cat, set()).add(uid)
        for e in msg.emotes:  # emote meaning counts as a reaction too (KEKW → funny)
            cat = lexicon.EMOTE_CATEGORIES.get(e.lower())
            if cat:
                b.reaction_users.setdefault(cat, set()).add(uid)

    def prune(self, now: datetime) -> None:
        cutoff = now - timedelta(seconds=BASELINE_SECONDS + WINDOW_BUCKETS * BUCKET_SECONDS)
        while self.buckets and self.buckets[0].start < cutoff:
            self.buckets.popleft()
        if len(self._phrase_category) >= 5000:  # bounded memory: rebuild lazily
            self._phrase_category.clear()

    def _filled(self, start: datetime, end: datetime) -> list[Bucket]:
        """Buckets in [start, end), with empty buckets for silent intervals."""
        have = {b.start: b for b in self.buckets if start <= b.start < end}
        out, t = [], start
        while t < end:
            out.append(have.get(t) or Bucket(start=t))
            t += timedelta(seconds=BUCKET_SECONDS)
        return out

    def features(self, now: datetime) -> tuple[WindowFeatures, Baseline]:
        """Window = the last WINDOW_BUCKETS *completed* buckets before `now`."""
        end = _floor(now)
        start = end - timedelta(seconds=WINDOW_BUCKETS * BUCKET_SECONDS)
        win = self._filled(start, end)

        users: set[str] = set()
        emotes: dict[str, set[str]] = {}
        phrases: dict[str, set[str]] = {}
        reactions: dict[str, set[str]] = {}
        clips: set[str] = set()
        for b in win:
            users |= set(b.user_messages)
            clips |= b.clip_users
            for k, v in b.emote_users.items():
                emotes.setdefault(k, set()).update(v)
            for k, v in b.phrase_users.items():
                phrases.setdefault(k, set()).update(v)
            for k, v in b.reaction_users.items():
                reactions.setdefault(k, set()).update(v)
        feats = WindowFeatures(
            start=start,
            end=end,
            effective_messages=sum(b.effective for b in win),
            raw_messages=sum(b.raw_messages for b in win),
            unique_users=len(users),
            emote_users={k: len(v) for k, v in emotes.items()},
            phrase_users={k: len(v) for k, v in phrases.items()},
            phrase_categories={k: self._phrase_category.get(k) for k in phrases},
            reaction_users={k: len(v) for k, v in reactions.items()},
            clip_requesters=len(clips),
            sentiment=_sentiment(reactions),
        )

        # Baseline: everything before the window, back to BASELINE_SECONDS (only since the
        # first bucket we have, so a fresh stream isn't compared to imaginary silence).
        first = self.buckets[0].start if self.buckets else start
        base_start = max(first, start - timedelta(seconds=BASELINE_SECONDS))
        hist = self._filled(base_start, start) if base_start < start else []
        counts = [b.effective for b in hist]
        n = len(counts)
        mean = sum(counts) / n if n else 0.0
        std = math.sqrt(sum((c - mean) ** 2 for c in counts) / n) if n else 0.0
        windows = max(1.0, n / WINDOW_BUCKETS)
        emote_totals: Counter[str] = Counter()
        phrase_totals: Counter[str] = Counter()
        reaction_totals: Counter[str] = Counter()
        sentiments: list[float] = []
        for b in hist:
            for k, v in b.emote_users.items():
                emote_totals[k] += len(v)
            for k, v in b.phrase_users.items():
                phrase_totals[k] += len(v)
            for k, v in b.reaction_users.items():
                reaction_totals[k] += len(v)
            s = _sentiment(b.reaction_users)
            if s is not None:
                sentiments.append(s)
        baseline = Baseline(
            buckets=n,
            mean=mean,
            std=std,
            per_window_emote_users={k: v / windows for k, v in emote_totals.items()},
            per_window_phrase_users={k: v / windows for k, v in phrase_totals.items()},
            per_window_reaction_users={k: v / windows for k, v in reaction_totals.items()},
            sentiment_mean=sum(sentiments) / len(sentiments) if sentiments else None,
        )
        return feats, baseline

    def activity(self, now: datetime, buckets: int = 36) -> dict[str, object]:
        """Summary for the Live Monitoring view (no message content)."""
        end = _floor(now)
        recent = self._filled(end - timedelta(seconds=buckets * BUCKET_SECONDS), end)
        last_min = recent[-12:]
        _, base = self.features(now)
        return {
            "bucket_seconds": BUCKET_SECONDS,
            "messages_per_minute": sum(b.raw_messages for b in last_min),
            "unique_chatters_per_minute": len({u for b in last_min for u in b.user_messages}),
            "baseline_messages_per_minute": round(base.mean * (60 / BUCKET_SECONDS), 1),
            "warming_up": not base.ready,
            "series": [b.raw_messages for b in recent],
        }
