# StreamHunter: Database Schema

SQLAlchemy 2 models in `backend/app/models/`, migrations in `backend/migrations/` (Alembic).
SQLite for local development and PostgreSQL in production. The same migrations run on both:
SQLite uses Alembic's batch mode, and every constraint has a deterministic name.

**Timestamps** use a custom `UTCDateTime` type. Values are stored as UTC and always come back
timezone-aware, and naive datetimes are rejected on write. On PostgreSQL the column is
`TIMESTAMP WITH TIME ZONE`.

```text
users ─┬─< auth_sessions
       ├─< platform_connections        (one per platform)
       ├── user_settings               (one per user, JSON)
       ├─< user_streamers >── streamers (shared channel records)
       ├─< monitoring_sessions >── streamers
       │        └─< stream_events
       ├─< highlight_candidates >── monitoring_sessions, streamers
       └─< clips >── highlight_candidates
```

All foreign keys to `users` and `streamers` cascade on delete.

## Tables

| Table | Key columns | Constraints / indexes | Notes |
|---|---|---|---|
| `users` | email, username, hashed_password | `uq(email)` | Argon2id hashes; email stored lowercase |
| `auth_sessions` | user_id, token_hash, expires_at, revoked_at, last_used_at, user_agent | `uq(token_hash)`, `ix(user_id)` | **Addition to the spec.** Opaque, revocable bearer sessions; only the SHA-256 of the token is stored |
| `platform_connections` | user_id, platform, platform_user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes (JSON), connection_status | `uq ix(user_id, platform)` | Tokens are Fernet-encrypted (Phase 3) |
| `streamers` | platform, platform_user_id, username, display_name, profile_image_url, is_live, current_title, current_category, viewer_count, stream_started_at, status_checked_at, monitoring_enabled | `uq(platform, platform_user_id)`, `ix(platform, username)`, `ix(is_live)` | Shared across users. `is_live` is `NULL` until checked. `monitoring_enabled` = at least one user monitors it. `status_checked_at` is an addition |
| `user_streamers` | user_id, streamer_id, is_favorite, monitoring_enabled | `uq(user_id, streamer_id)` | The per-user watchlist and source of truth for monitoring per user |
| `monitoring_sessions` | user_id, streamer_id, platform, started_at, ended_at, status, last_checked_at, last_event_at, error_message | `ix(user_id, status)`, `ix(streamer_id)` | status: `active · paused · ended · error` |
| `stream_events` | session_id, streamer_id, event_type, platform_timestamp, stream_offset_sec, confidence, metadata (JSON) | `ix(session_id, created_at)`, `ix(streamer_id)` | Aggregated detector output only, never raw chat. The Python attribute is `event_metadata` because `metadata` is reserved |
| `highlight_candidates` | **user_id**, session_id, streamer_id, platform, start/end_offset_sec, timestamp, score, confidence, category, reasons (JSON), signal_breakdown (JSON), status | `ix(user_id, timestamp)`, `ix(user_id, status)`, `ix(streamer_id)` | `user_id` is denormalized (an addition) so every query can be scoped to its owner cheaply |
| `clips` | candidate_id, user_id, platform, platform_clip_id, platform_clip_url, local_file_path, title, duration_seconds, aspect_ratio, status, error_message | `ix(user_id, created_at)`, `ix(candidate_id)` | A platform clip URL and a local file are tracked separately |
| `user_settings` | user_id, settings (JSON) | `uq(user_id)` | Validated by `UserSettingsModel` on every write |

## Status lifecycle (`highlight_candidates.status`, `clips.status`)

Enforced in `app/domain/status.py`. Every change goes through `transition()`, and reaching
`published` requires `user_confirmed=True`:

```text
detected → pending_review → approved → creation_requested → created → exporting → ready → published
     └→ rejected ⇄ pending_review     └→ unsupported → published (manual)    failed → retry
```

## Migrations

From `backend/`, apply all migrations:

```bash
.venv/bin/alembic upgrade head
```

Create a new migration after changing models:

```bash
.venv/bin/alembic revision --autogenerate -m "describe change"
```

Roll back one migration:

```bash
.venv/bin/alembic downgrade -1
```

A test (`tests/test_core.py`) applies every migration to a fresh database and fails if the result
differs from the models. It also checks that downgrading removes everything.

## Data minimization
* Raw chat messages are never persisted. Only per-window aggregates in `stream_events.metadata`.
* `privacy.retentionDays` in user settings sets how long events are kept. The cleanup job
  arrives with monitoring in Phase 4.
