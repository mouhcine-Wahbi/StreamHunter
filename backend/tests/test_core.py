"""Pure units: state machine, crypto, time type, rate limiter, log redaction, migrations."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, inspect

import app.models  # noqa: F401
from app.db.base import Base
from app.db.types import UTCDateTime
from app.domain.enums import ClipStatus as S
from app.domain.status import transition
from app.errors import InvalidTransitionError
from app.logging_config import JsonFormatter, redact
from app.utils.crypto import TokenCipher, TokenCipherUnavailable
from app.utils.rate_limit import SlidingWindowLimiter

BACKEND = Path(__file__).resolve().parents[1]


# --- status transitions ---
def test_valid_transitions() -> None:
    assert transition("pending_review", "approved") == S.APPROVED
    assert transition(S.FAILED, S.CREATION_REQUESTED) == S.CREATION_REQUESTED


def test_invalid_transition_lists_allowed_targets() -> None:
    with pytest.raises(InvalidTransitionError) as e:
        transition("detected", "created")
    assert e.value.details["allowed"] == ["pending_review", "rejected"]


def test_publishing_requires_explicit_confirmation() -> None:
    with pytest.raises(InvalidTransitionError) as e:
        transition("ready", "published")
    assert e.value.code == "confirmation_required"
    assert transition("ready", "published", user_confirmed=True) == S.PUBLISHED
    with pytest.raises(InvalidTransitionError):
        transition("published", "ready", user_confirmed=True)  # terminal


def test_every_status_has_a_transition_entry() -> None:
    from app.domain.status import ALLOWED_TRANSITIONS

    assert set(ALLOWED_TRANSITIONS) == set(S)


# --- token encryption ---
def test_token_cipher_roundtrip_and_refusal_without_key() -> None:
    key = Fernet.generate_key().decode()
    c = TokenCipher(key)
    enc = c.encrypt("oauth-access-token")
    assert enc != "oauth-access-token" and c.decrypt(enc) == "oauth-access-token"
    with pytest.raises(ValueError):
        TokenCipher(Fernet.generate_key().decode()).decrypt(enc)  # wrong key
    with pytest.raises(TokenCipherUnavailable):
        TokenCipher(None).encrypt("x")
    with pytest.raises(ValueError):
        TokenCipher("not-a-key")


# --- UTC datetime type ---
def test_utc_datetime_normalizes_and_rejects_naive() -> None:
    t = UTCDateTime()
    sqlite = create_engine("sqlite://").dialect
    paris = datetime(2026, 11, 13, 12, 0, tzinfo=timezone(timedelta(hours=1)))
    stored = t.process_bind_param(paris, sqlite)
    assert stored == datetime(2026, 11, 13, 11, 0) and stored.tzinfo is None
    assert t.process_result_value(stored, sqlite) == datetime(2026, 11, 13, 11, 0, tzinfo=UTC)
    with pytest.raises(ValueError):
        t.process_bind_param(datetime(2026, 1, 1), sqlite)


# --- rate limiter ---
def test_sliding_window() -> None:
    now = [0.0]
    lim = SlidingWindowLimiter(2, 60, clock=lambda: now[0])
    assert lim.hit("a") and lim.hit("a") and not lim.hit("a")
    assert lim.hit("b")
    now[0] = 61
    assert lim.hit("a")


# --- logging ---
def test_redaction() -> None:
    assert "abc.def" not in redact("Authorization: Bearer abc.def")
    assert redact("GET /cb?code=SECRET&state=1") == "GET /cb?code=[REDACTED]&state=1"
    assert "s3cr3t" not in redact('{"client_secret": "s3cr3t"}')


def test_json_formatter_redacts_extras() -> None:
    rec = logging.makeLogRecord({"msg": "token Bearer xyz", "levelname": "INFO", "name": "t", "header": "Bearer qqq"})
    out = JsonFormatter().format(rec)
    assert "xyz" not in out and "qqq" not in out


# --- migrations ---
def _alembic(url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    cfg.attributes["database_url"] = url
    cfg.attributes["configure_logger"] = False
    return cfg


def test_migrations_upgrade_match_models_and_downgrade(tmp_path: Path) -> None:
    db = tmp_path / "m.db"
    cfg = _alembic(f"sqlite+aiosqlite:///{db}")
    command.upgrade(cfg, "head")

    sync = create_engine(f"sqlite:///{db}")
    with sync.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
        tables = set(inspect(conn).get_table_names())
    assert diff == [], f"models and migrations differ: {diff}"
    assert {"users", "streamers", "user_streamers", "monitoring_sessions", "stream_events",
            "highlight_candidates", "clips", "platform_connections", "user_settings", "auth_sessions"} <= tables

    command.downgrade(cfg, "base")
    with sync.connect() as conn:
        assert set(inspect(conn).get_table_names()) <= {"alembic_version"}
    sync.dispose()
