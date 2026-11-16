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
| 502 | `platform_auth_failed`, `upstream_error` | Twitch/Kick rejected our credentials or returned something unexpected |
| 503 | `platform_not_configured`, `platform_unreachable`, `platform_timeout`, `platform_rate_limited`, `encryption_not_configured`, `requires_authorization` | Platform feature currently unavailable; the message says why |

## Endpoints

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

### Platform connections (OAuth, Phase 3)
| | |
|---|---|
| `GET /api/v1/auth/{platform}/authorize` | → `{authorization_url, expires_at}`. Open the URL in a browser tab. Needs `TOKEN_ENCRYPTION_KEY` (503 `encryption_not_configured` otherwise) |
| `GET /api/v1/auth/{platform}/callback?code&state` | Redirect target registered with Twitch/Kick. Returns a small HTML result page (400 on failure). `state` is single use, bound to user and platform, valid 10 min |
| `GET /api/v1/auth/{platform}/status` | `{configured, connection_status, platform_user_id, platform_username, scopes, token_expires_at, last_error}` |
| `POST /api/v1/auth/{platform}/disconnect` | Revokes the tokens at the platform (best effort) and deletes them → 204 |

Twitch uses the authorization-code flow (scopes `user:read:chat clips:edit`). Kick uses authorization
code + **PKCE S256** (scopes `user:read channel:read events:subscribe`). Client secrets never leave the backend.

### Streamers (watchlist)
| | |
|---|---|
| `GET /api/v1/streamers/search?platform=twitch\|kick&username=…&limit=10` | Twitch: Helix channel search. **Kick: exact channel-name lookup** (Kick has no search API) |
| `GET /api/v1/streamers` | Your watchlist (favorites first) |
| `POST /api/v1/streamers` | `{platform, username}`: the channel is **resolved through the platform API** before it's stored. 201, or 409 `already_in_watchlist` |
| `GET /api/v1/streamers/{id}` | One entry |
| `PATCH /api/v1/streamers/{id}` | `{monitoring_enabled?, is_favorite?}` |
| `DELETE /api/v1/streamers/{id}` | Removes it from *your* watchlist (the shared channel record stays) → 204 |

### Streams (last known state)
| | |
|---|---|
| `GET /api/v1/streams/live` | Watchlist entries currently known to be live |
| `POST /api/v1/streams/refresh` | Checks your whole watchlist now (batched per platform; skips streamers checked < 30 s ago) → `{checked, live, skipped_recent, unavailable{platform: reason}}` |
| `GET /api/v1/streams/{streamer_id}` | Last known state, no platform call: `{is_live, title, category, viewer_count, started_at, last_checked_at}` |
| `GET /api/v1/streams/{streamer_id}/status` | Same shape, **freshly fetched** from the platform (503 `status_unavailable` if it can't be) |

### Browser monitoring (Phase 4)
| | |
|---|---|
| `POST /api/v1/monitoring/start` | `{client, interval_seconds (30–3600), since?}`: grants the lease and checks your watchlist immediately |
| `POST /api/v1/monitoring/heartbeat` | Same body. Extends the lease (TTL = max(`MONITORING_LEASE_TTL_SECONDS`, 3 × interval + 60 s)) → `{lease_expires_at, interval_seconds, started, active_sessions, live_count, notifications[], server_time}`. `notifications` are `streamer_live` / `streamer_offline` / `highlight_detected` (with `highlight_id`, `score`) after `since` |
| `POST /api/v1/monitoring/stop` | Releases the lease now; active sessions are paused → 204 |
| `GET /api/v1/monitoring/status` | `{lease_active, lease_expires_at, last_heartbeat_at, active_sessions, paused_sessions, scheduler_running, last_cycle_at}` |
| `GET /api/v1/monitoring?status=` | Session history (`active · paused · ended · error`) |
| `GET /api/v1/monitoring/{id}` / `/{id}/events` | One session / its events (`stream_online`, `stream_offline`, and the detector events behind each highlight). Aggregates only, no chat text |
| `GET /api/v1/monitoring/{id}/activity` | Live chat state for an active session: `{chat_state: connecting\|connected\|unavailable\|not_monitored, chat_reason, messages_per_minute, unique_chatters_per_minute, baseline_messages_per_minute, warming_up, series[36], active_signals[]}`. In-memory aggregates only |

How it works: while a lease is active, the backend scheduler polls the live status of that user's
monitored streamers. It batches per platform, polls each streamer at most once per the shortest
interval among its users (never more often than `MIN_POLL_SECONDS`), and backs off a failing
platform (30 s → 15 min). When a streamer goes live a session opens. It ends when the stream ends,
pauses when the lease lapses, and resumes after a pause for the same broadcast.

### Webhooks
| | |
|---|---|
| `POST /api/v1/webhooks/kick` | Kick event delivery. Register `{KICK_WEBHOOK_PUBLIC_URL}/api/v1/webhooks/kick` in your Kick app. Requests must carry a valid `Kick-Event-Signature` (RSA-SHA256 over `id.timestamp.body`, verified with Kick's published key), a timestamp within ±5 min and an unseen message id; otherwise 401 `invalid_signature`. `chat.message.sent` feeds the analyzer. Verified deliveries always get 200 |

### Highlights (review)
| | |
|---|---|
| `GET /api/v1/highlights` | Filters: `platform, streamer_id, category, min_score, status, date_from, date_to`. Each item includes `clip` (`{id, status, platform_clip_url, error_message}` or null) and `streamer_username` |
| `GET /api/v1/highlights/{id}` | One candidate with `reasons` and `signal_breakdown` |
| `POST /api/v1/highlights/{id}/approve` | `pending_review → approved`; prepares its clip → `{highlight, clip}`. Twitch: clip `approved` (not requested yet). Kick: clip `unsupported`, with manual instructions in `error_message` |
| `POST /api/v1/highlights/{id}/reject` | `→ rejected` (also from `approved`) |
| `PATCH /api/v1/highlights/{id}` | `{status: "pending_review"}` reopens a rejected highlight. Also `start_offset_sec`, `end_offset_sec` (window ≤ 180 s) and `category` |

### Clips
| | |
|---|---|
| `GET /api/v1/clips?status=&platform=` / `/{id}` | `{…, platform_clip_url, edit_url, local_file_path, subtitles_file_path, source: auto\|editor\|manual, requested_at, request_lag_seconds, published_at, published_url}`. A platform clip URL and a local file are separate on purpose |
| `POST /api/v1/clips/{id}/create` | `{accept_current_moment?: false}`. Twitch only: needs a connected account with `clips:edit` (503 `requires_authorization`) and a live channel (409 `stream_offline`). For moments older than 90 s it answers 409 `moment_passed` unless `accept_current_moment` is true, because Twitch clips what is on air *now*. The clip is requested immediately and confirmed via Get Clips (up to ~25 s) → `created` with its URL, or `failed` with a reason. Kick: 409 `requires_manual_action` |
| `POST /api/v1/clips/{id}/retry` | Same as create, for `failed` clips |
| `PATCH /api/v1/clips/{id}` | `{title?, aspect_ratio?, platform_clip_url?}`. The URL is for the manual workflow (must be https on kick.com / clips.twitch.tv) and turns `unsupported` into `created` |
| `POST /api/v1/clips/{id}/export` | Optional body `{subtitles?: false, language?: "en"}`. With a recording attached to the highlight's session: 202, clip → `exporting` → `ready` (MP4 trimmed to the highlight window, reframed to the clip's aspect ratio 9:16 / 1:1 / 16:9, loudness-normalized). With `subtitles: true` the clip's speech is transcribed locally and burned into the picture, and `subtitles_file_path` names the .srt (null when no speech was found; the job result has `subtitles: {file, language, cues, burned_in}`). `language` is an ISO 639-1 code; omitted = detected. Without a recording: 409 `media_unavailable`. A recording that doesn't cover the moment: 400 `outside_recording`. Subtitles without speech recognition installed: 503 `subtitles_unavailable`; a recording without audio: 400 `no_audio`. If the export fails, the clip returns to its previous status with `Export failed: …`. Exporting without subtitles removes earlier captions |
| `GET /api/v1/clips/{id}/file` | Download the exported MP4 (authenticated) |
| `GET /api/v1/clips/{id}/subtitles` | Download the clip's subtitles as SRT (`application/x-subrip`); 404 if the last export had none |
| `POST /api/v1/clips/{id}/publish` | `{confirm: true, published_url?}`. Records that **you** published it. StreamHunter never posts anywhere; without `confirm: true` the request is rejected (422) |

**Auto-capture:** with `clips.autoCreatePlatformClips` on (the default), a Twitch highlight that meets
your minimum score gets its official clip requested the moment it is detected (`source: "auto"`).
The highlight itself stays `pending_review`.

### Recordings & post-stream analysis (Phase 7)
StreamHunter only processes recordings **you** provide and confirm you have the rights to.
It never downloads media from Twitch or Kick.

| | |
|---|---|
| `GET /api/v1/media/capabilities` | `{ffmpeg_available, max_upload_mb, media_folder, supported_extensions, audio_analysis, visual_analysis, export, subtitles: "supported"\|"requires_configuration", sound_events: "supported"\|"requires_configuration", live_tab_audio: "supported", platform_vod_download: "unsupported"}` |
| `POST /api/v1/media/upload` | multipart: `file`, `rights_confirmed=true` (required), `session_id?`, `offset_in_stream_sec` (stream second at file time 0; 0 for a full VOD). Streamed to disk with a size limit, then probed with ffprobe; 400 `invalid_media` if it isn't audio/video |
| `POST /api/v1/media/register` | `{relative_path, rights_confirmed: true, session_id?, offset_in_stream_sec}` for large files already copied into `media_folder`. Paths outside that folder are refused |
| `GET /api/v1/media?session_id=` · `PATCH /api/v1/media/{id}` · `DELETE /api/v1/media/{id}` | List / attach to a session or change the offset / forget (uploaded files are deleted; registered files are left alone) |
| `POST /api/v1/media/{id}/analyze` | 202 → job. Loudness per second and scene changes. Existing highlights the recording covers get **measured** `audio` / `visual` signals and a recomputed score (`chat_only_score` is kept). Strong loudness peaks with no chat highlight become `origin: "vod"` highlights (category `unknown`). Overlapping pending highlights are merged (`origin: "merged"`). With sound classification: `signal_breakdown.sounds = {laughter, cheering, screaming}` (strongest value 0–1 in the window; a kind = its YAMNet classes summed, capped at 1, best of two half-second windows per second), `audio_loudness` (the loudness part), and `audio` = the stronger of the two; a clear sound names `unknown` / `other` / `audience_reaction` highlights; laughter/cheering/screaming events chat missed become `origin: "vod"` highlights with that category. Result adds `sound_classification: done\|not_installed\|no_audio\|failed: …` and `sound_events: {laughter, cheering, screaming}` counts |
| `GET /api/v1/media/jobs/{id}` | `{status: queued\|running\|succeeded\|failed, result, error_message}` |
| `POST /api/v1/monitoring/audio` | Live tab loudness from the extension: `{platform, channel, sent_at, samples: [{t, db}]}` (≤ 120 samples, one per second, dBFS; `channel` is the login/slug from the tab URL). Matched to your **active** session for that channel (404 `not_monitoring` otherwise). Times are corrected by `server time − sent_at`. Returns `{session_id, streamer_id, accepted, audio_state}`. New live highlights then carry `signal_breakdown.audio` with `audio_source: "live_tab"` and `chat_only_score`; `GET …/{id}/activity` adds `audio_state` (off/receiving/stale), `audio_level_db`, `audio_delta_db`, `audio_warming_up` |
| `POST /api/v1/monitoring/{id}/vod` | Look up the Twitch VOD now (also done automatically every 30 min for recent sessions). Highlights then carry `vod_url_at` (`…/videos/<id>?t=1h2m5s`, approximate) |

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
`/ws/monitoring`: not planned for the MVP. A Manifest V3 service worker can't hold a socket open, so events arrive with each heartbeat instead ·
Live laughter detection and gameplay/visual event recognition (see IMPLEMENTATION_STATUS.md).
