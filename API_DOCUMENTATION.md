# StreamHunter API

Base URL (local): `http://localhost:8000`. Interactive docs: **`/docs`** (Swagger UI), `/redoc`, and the
machine-readable spec at `/openapi.json`. The spec is generated from the code and is the source of truth;
this page is the overview.

## Conventions

* JSON in and out. Timestamps are ISO 8601 in **UTC** (`2026-11-15T06:29:41Z`).
* **Auth:** `Authorization: Bearer <session token>` from `/api/v1/auth/login` or `/register`.
  This is a StreamHunter session, never a Twitch/Kick token.
* **Pagination:** `?limit=` (1–100, default 50) and `?offset=`. Responses look like
  `{"items": [...], "total": 12, "limit": 50, "offset": 0}`.
* **Errors** always use one envelope:

```json
{ "error": { "code": "already_in_watchlist", "message": "This streamer is already in your watchlist", "details": { "streamer_id": 3 } } }
```

| Status | Typical `code` | Meaning |
|---|---|---|
| 401 | `not_authenticated`, `invalid_session`, `invalid_credentials` | Missing, expired or revoked session |
| 403 | `registration_disabled` | Action not allowed on this backend |
| 404 | `not_found`, `channel_not_found` | Missing **or belongs to another user** (indistinguishable on purpose) |
| 409 | `email_taken`, `already_in_watchlist`, `invalid_status_transition`, `confirmation_required` | Conflict with current state |
| 422 / 400 | `validation_error` | Invalid input; `details.errors` lists fields |
| 429 | `rate_limited` | Too many auth attempts |
| 501 | `not_implemented` | Platform feature not built yet in this version |
| 503 | `platform_not_configured` | Backend lacks the platform credentials |

## Endpoints (Phase 2)

### Health
| | |
|---|---|
| `GET /health`, `GET /api/v1/health` | `{"status":"ok","version":"0.2.0","environment":"development","database":"ok"}`; 503 if the DB is down |

### Auth
| | |
|---|---|
| `POST /api/v1/auth/register` | `{email, username, password(≥10)}` → 201 `{access_token, token_type, expires_at, user}` (rate limited) |
| `POST /api/v1/auth/login` | `{email, password}` → `{access_token, …}` (rate limited) |
| `POST /api/v1/auth/logout` | Revokes the current session → 204 |
| `GET /api/v1/auth/me` | The signed-in user |

Platform OAuth (`/api/v1/auth/{platform}/authorize|callback|status|disconnect`) arrives in Phase 3.

### Streamers (watchlist)
| | |
|---|---|
| `GET /api/v1/streamers/search?platform=twitch\|kick&username=…&limit=10` | Live search through the platform adapter |
| `GET /api/v1/streamers` | Your watchlist (favorites first) |
| `POST /api/v1/streamers` | `{platform, username}`: the channel is **resolved through the platform API** before it's stored. 201, or 409 `already_in_watchlist` |
| `GET /api/v1/streamers/{id}` | One entry |
| `PATCH /api/v1/streamers/{id}` | `{monitoring_enabled?, is_favorite?}` |
| `DELETE /api/v1/streamers/{id}` | Removes it from *your* watchlist (the shared channel record stays) → 204 |

### Streams (last known state)
| | |
|---|---|
| `GET /api/v1/streams/live` | Watchlist entries currently known to be live |
| `GET /api/v1/streams/{streamer_id}` and `/status` | `{is_live, title, category, viewer_count, started_at, last_checked_at}`. `last_checked_at` is `null` until monitoring has checked |

### Monitoring, highlights, clips (read; writes arrive in Phases 4–6)
| | |
|---|---|
| `GET /api/v1/monitoring?status=` | Session history |
| `GET /api/v1/monitoring/{id}` / `/{id}/events` | One session / its detection events (aggregates only, no chat text) |
| `GET /api/v1/highlights` | Filters: `platform, streamer_id, category, min_score, status, date_from, date_to` |
| `GET /api/v1/highlights/{id}` | One candidate with `reasons` and `signal_breakdown` |
| `GET /api/v1/clips?status=&platform=` / `/{id}` | Clip library. `platform_clip_url` and `local_file_path` are separate on purpose |

### Settings
| | |
|---|---|
| `GET /api/v1/settings` | Your settings (defaults if never saved) |
| `PATCH /api/v1/settings` | Deep-merges a partial object and validates it; unknown keys are rejected |

### Platforms
| | |
|---|---|
| `GET /api/v1/platforms/capabilities` | Per platform: `configured`, `connection_status`, `capabilities{…}`, `notes[]` |

Capability values: `supported`, `requires_configuration`, `requires_authorization`, `requires_manual_action`,
`conditional`, `not_guaranteed`, `not_implemented`, `unsupported`. They are computed from the backend's
configuration and your connection state, never hardcoded in the UI.

## Not yet available (planned)
`POST /api/v1/monitoring/heartbeat|start|stop` (Phase 4) · `/ws/monitoring` (Phase 4/5) ·
`POST /api/v1/highlights/{id}/approve|reject`, `PATCH /api/v1/highlights/{id}` (Phase 5/6) ·
`POST /api/v1/clips/{id}/create|export|retry`, `PATCH /api/v1/clips/{id}` (Phase 6).
