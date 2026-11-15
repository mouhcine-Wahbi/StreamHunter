# StreamHunter: Database Schema

SQLAlchemy 2 models in `backend/app/models/`, migrations in `backend/migrations/` (Alembic).
SQLite for local development and PostgreSQL in production. The same migrations run on both:
SQLite uses Alembic's batch mode, and every constraint has a deterministic name.

**Timestamps** use a custom `UTCDateTime` type. Values are stored as UTC and always come back
timezone-aware, and naive datetimes are rejected on write. On PostgreSQL the column is
`TIMESTAMP WITH TIME ZONE`.

```text
users ─┬─< auth_sessions
       ├─< oauth_states
       ├─< platform_connections        (one per platform)
       ├── user_settings               (one per user, JSON)
       ├─< user_streamers >── streamers (shared channel records)
       ├── monitoring_leases           (one per user)
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
| `platform_connections` | user_id, platform, platform_user_id, platform_username, access_token_enc, refresh_token_enc, token_expires_at, scopes (JSON), connection_status, last_error | `uq ix(user_id, platform)` | Tokens are Fernet-encrypted; refreshed automatically 5 min before expiry |
| `oauth_states` | user_id, platform, state_hash, code_verifier_enc, expires_at, used_at | `uq(state_hash)`, `ix(user_id)` | **Addition (Phase 3).** Pending authorizations: single use, 10 min, only the state's SHA-256 stored, PKCE verifier encrypted |
| `streamers` | platform, platform_user_id, username, display_name, profile_image_url, is_live, current_title, current_category, viewer_count, stream_started_at, status_checked_at, monitoring_enabled | `uq(platform, platform_user_id)`, `ix(platform, username)`, `ix(is_live)` | Shared across users. `is_live` is `NULL` until checked. `monitoring_enabled` = at least one user monitors it. `status_checked_at` is an addition |
| `user_streamers` | user_id, streamer_id, is_favorite, monitoring_enabled | `uq(user_id, streamer_id)` | The per-user watchlist and source of truth for monitoring per user |
| `monitoring_sessions` | user_id, streamer_id, platform, started_at, ended_at, status, last_checked_at, last_event_at, error_message, broadcast_started_at | `ix(user_id, status)`, `ix(streamer_id)` | status: `active · paused · ended · error`. `broadcast_started_at` (addition) identifies the broadcast, so a paused session resumes only for the same stream; it is also the base for approximate stream offsets |
| `monitoring_leases` | user_id, client, interval_seconds, started_at, last_heartbeat_at, expires_at, released_at | `uq(user_id)`, `ix(expires_at)` | **Addition (Phase 4).** Browser lease; no lease = no polling for that user |
| `stream_events` | session_id, streamer_id, event_type, platform_timestamp, stream_offset_sec, confidence, metadata (JSON) | `ix(session_id, created_at)`, `ix(streamer_id)` | Aggregated detector output only, never raw chat. The Python attribute is `event_metadata` because `metadata` is reserved |
| `highlight_candidates` | **user_id**, session_id, streamer_id, platform, start/end_offset_sec, timestamp, score, confidence, category, reasons (JSON), signal_breakdown (JSON), status | `ix(user_id, timestamp)`, `ix(user_id, status)`, `ix(streamer_id)` | `user_id` is denormalized (an addition) so every query can be scoped to its owner cheaply |
| `clips` | candidate_id, user_id, platform, platform_clip_id, platform_clip_url, local_file_path, title, duration_seconds, aspect_ratio, status, error_message, source, edit_url, requested_at, request_lag_seconds, published_at, published_url | `ix(user_id, created_at)`, `ix(candidate_id)` | A platform clip URL and a local file are tracked separately. `source` = auto / editor / manual; `request_lag_seconds` = time between the peak and the Twitch request (Phase 6 additions) |
| `user_settings` | user_id, settings (JSON) | `uq(user_id)` | Validated by `UserSettingsModel` on every write |

## Status lifecycle (`highlight_candidates.status`, `clips.status`)

Enforced in `app/domain/status.py`. Every change goes through `transition()`, and reaching
`published` requires `user_confirmed=True`:

```text
highlight:  pending_review → approved | rejected;  approved → rejected;  rejected → pending_review
clip (starts as approved, creation_requested or unsupported):
  approved → creation_requested → created | failed;  failed → creation_requested (retry)
  unsupported (Kick) → created (editor pasted the clip URL)
  created | ready | unsupported → published   (only with explicit confirmation)
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
* `privacy.retentionDays` (synced from the extension) sets how long events are kept. The scheduler
  runs an hourly sweep that deletes older `stream_events`, OAuth states expired for more than a day,
  and auth sessions expired or revoked for more than 30 days. Highlights, clips and session history are kept.
