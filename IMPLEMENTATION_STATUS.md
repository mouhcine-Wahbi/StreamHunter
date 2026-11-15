# StreamHunter — Implementation Status

_Last updated: 2026-11-15_

Legend: ✅ done & verified · 🟡 partial · ⏳ not started · 🚫 not possible with official APIs

## Phase 0 — Inspection & planning ✅

| Item | Status | Notes |
|---|---|---|
| Repository inspection | ✅ | The directory was empty, so this is a new project |
| PROJECT_PLAN.md / ARCHITECTURE.md | ✅ | |
| Kick API research | 🟡 | Read from the official `KickEngineering/KickDevDocs` repo. docs.kick.com and the OpenAPI spec were unreachable from the dev container, so the exact query parameters must be confirmed |
| Twitch API research | 🟡 | dev.twitch.tv was unreachable from the dev container. The facts come from prior knowledge and are marked unverified |

## Phase 1 — Extension foundation ✅

| Item | Status | Notes |
|---|---|---|
| Vite + React 19 + TS (strict) + Tailwind 4 | ✅ | `extension/` |
| Manifest V3 (popup, side panel, module service worker) | ✅ | Minimum permissions |
| Full-page workspace with 7 sections + hash navigation | ✅ | |
| Popup control center | ✅ | Status, live count, recent highlights, start/stop, open workspace/side panel |
| Side panel highlight feed | ✅ | |
| Dark theme / design tokens / accessible components | ✅ | Buttons, cards, badges, switch, fields, segmented, empty states |
| Settings persisted in `chrome.storage.local` with validation | ✅ | Sanitized on read and write |
| Background worker: alarms, typed messaging, badge | ✅ | |
| Monitoring state machine + exponential backoff + restore on startup | ✅ | The backend side of the lease comes in Phase 4 |
| API client (timeouts, typed errors, bearer auth) | ✅ | |
| Truthful backend states (unreachable / 404 / 401) in every view | ✅ | No sample data anywhere |
| Unit/component tests | ✅ | 49 tests (Vitest + Testing Library + fake Chrome APIs) |
| Real-browser check (Chromium + built extension) | ✅ | Load, popup, all routes, settings across reload, heartbeat → active, state across worker stop. No unexpected console errors |

### What works right now, without a backend
The extension installs and opens. Navigation and settings work. Monitoring can be
switched on and off and honestly shows **Backend offline** with backoff.

### What waits on the backend
Every data view (watchlist, search, sessions, highlights, clips, platform
connections) already calls its real `/api/v1` endpoint. Until that endpoint exists,
the view says so ("Backend not reachable" or "Not available on this backend").

## Phase 2 — Backend foundation ✅

| Item | Status | Notes |
|---|---|---|
| FastAPI app factory, consistent error envelope, JSON logging with secret redaction | ✅ | `backend/app/` |
| SQLAlchemy 2 (async) models for all 10 tables + UTC-safe datetime type | ✅ | SQLite (aiosqlite); PostgreSQL via asyncpg URL |
| Alembic initial migration | ✅ | Tested: upgrade matches the models exactly; downgrade is clean |
| Health `/health`, `/api/v1/health` (with DB check) | ✅ | |
| Accounts: register / login / logout / me | ✅ | Argon2id, opaque revocable sessions (only hashes stored), uniform login errors, rate limiting |
| Watchlist API (search, list, add, get, patch, delete) | ✅ | Ownership-scoped, no duplicates, shared channel rows, per-user monitoring flag |
| Streams, monitoring sessions/events, highlights, clips: read endpoints | ✅ | Real DB queries with filters and pagination. Writes come in Phases 4–6 |
| Settings API (GET/PATCH, validated deep merge) | ✅ | The extension still stores settings locally; syncing comes in Phase 4 |
| Platform adapter interface + registry + capability reporting | ✅ | `StreamingPlatform` ABC; Twitch/Kick report real config state |
| Twitch/Kick API calls | ⏳ | Return 503 `platform_not_configured` or 501 `not_implemented`, never fake results |
| Clip status state machine (publish requires confirmation) | ✅ | `app/domain/status.py`, ready for Phases 5–6 |
| Token encryption utility (Fernet) | ✅ | Used once OAuth tokens are stored (Phase 3) |
| Extension: account sign-in / register / sign-out, 401 → "Sign in" action | ✅ | Data views refetch after sign-in |
| Backend tests | ✅ | 40 pytest tests |
| Extension tests | ✅ | 53 Vitest tests |
| Real stack check | ✅ | Built extension in Chromium + live uvicorn: sign-up, Overview counts, capabilities, Discover error. No console errors |

**Known gaps at the end of Phase 2**
* The monitoring heartbeat endpoint does not exist yet. Starting monitoring therefore shows
  *Degraded: this backend does not provide the monitoring endpoint (404)*. Phase 4 adds it.
* The data-retention cleanup job is not implemented yet (Phase 4). No chat data is collected yet, so nothing accumulates.

## Phase 3 — Twitch & Kick integration ✅ (code complete; live API check pending credentials)

| Item | Status | Notes |
|---|---|---|
| Shared HTTP layer: timeouts, retry on 5xx/network, rate-limit handling, error mapping | ✅ | `integrations/http.py` |
| App access tokens (client credentials), cached, renewed after 401 | ✅ | Both platforms |
| Twitch: search, channel lookup, batched live status (100 ids/request), title, category, viewers, start time | ✅ | Helix |
| Kick: channel lookup by exact name, profile picture, batched live status, title, category | ✅ | Kick has no search API; field names unverified (see ARCHITECTURE §3) |
| Account connections: authorize, callback, status, disconnect | ✅ | Twitch code flow; Kick code + PKCE; tokens encrypted; refresh before expiry |
| Capability reporting from real config + connection state | ✅ | |
| `POST /streams/refresh` and fresh `GET /streams/{id}/status` | ✅ | Skips streamers checked < 30 s ago |
| Extension: Connect/Disconnect, connected-as badge, Refresh status, last-checked times, Kick exact-name hint | ✅ | |
| Tests | ✅ | Backend 55 (mocked Twitch/Kick APIs) + 2 opt-in live tests; extension 57 |
| Live stack check | ✅ | Real uvicorn + built extension: capabilities, authorize URLs (PKCE for Kick), forged callback rejected, consent tab opens. Platform calls fail cleanly with `platform_unreachable` because Twitch/Kick are unreachable from the dev container |
| **Calls to the real Twitch/Kick APIs** | ⏳ | Needs credentials + network: `pytest -m integration` |

**Acceptance status:** searching both platforms, live status, and title/category all work against
mocked platform APIs with documented response shapes. The one remaining check, *"results are real
when credentials are configured"*, can only be confirmed with real credentials on a machine that can
reach Twitch and Kick.
## Phase 4 — Browser monitoring ✅

| Item | Status | Notes |
|---|---|---|
| Lease: start / heartbeat / stop / status endpoints | ✅ | TTL = max(360 s, 3 × interval + 60 s); stop releases immediately |
| Background scheduler (asyncio, in-process) | ✅ | Idle without leases; never crashes on a failed cycle |
| Batched status polling paced by user interval, ≥ `MIN_POLL_SECONDS` | ✅ | One platform call per batch, shared between users |
| Per-platform exponential backoff on outages (30 s → 15 min) | ✅ | Found during the live check: without it a down platform was retried every tick |
| Session lifecycle: open on live, end on offline, pause on lease loss, resume same broadcast, new session on restarted broadcast, end when monitoring is disabled or the streamer is removed | ✅ | `monitoring/reconciler.py` |
| Outage ≠ offline: unknown status never ends a session | ✅ | |
| "Went live" desktop notifications (opt-in) via heartbeat `since` | ✅ | `notifications` permission added; clicking opens Live Monitoring |
| Settings sync extension → backend (when signed in) | ✅ | The browser is the source of truth; `backendUrl` stays local |
| Retention sweep (events, OAuth states, old auth sessions) | ✅ | Hourly |
| Extension: Live now list, named sessions, live/active counts, recovery after worker restart | ✅ | |
| Tests | ✅ | Backend 66; extension 60 |
| Live stack check | ✅ | Built extension + uvicorn with scheduler: account, settings sync, start → lease active, worker stop → state and alarm kept, stop → lease released, scheduler polling with growing backoff (30 s, 60 s) while Twitch was unreachable |

**Not verifiable here:** real go-live/offline transitions need reachable platforms and credentials.
They are covered by tests that drive a fake platform through every transition.
## Phase 5 — Chat intelligence ✅ (live chat pending credentials)

| Item | Status | Notes |
|---|---|---|
| Rolling windows + per-stream baseline + per-user cap | ✅ | `detection/window.py` |
| Detectors: chat spike, emote wave, repeated phrase, clip request, multilingual reactions, sentiment shift | ✅ | 8 language packs + custom phrases from Settings |
| Bot, command and broadcaster filtering; spam resistance | ✅ | Tested: one spammer, bots and commands produce nothing |
| Event aggregation, renormalized scoring, evidence-based categories, explanations | ✅ | Missing audio/video are excluded, not counted as zero |
| Sensitivity per user (low / medium / high) on one shared analyzer | ✅ | |
| Candidates with score, confidence, category, reasons, signal breakdown, approximate offsets | ✅ | Status `pending_review` |
| Twitch chat via EventSub WebSocket (welcome, subscribe, keepalive, reconnect, revocation, backoff) | ✅ | Tested against a real local WebSocket server |
| Kick chat via signed webhooks (RSA verify, freshness, replay, key rotation) + subscribe/unsubscribe | ✅ | Request/response field names unverified (see ARCHITECTURE §3) |
| Chat state + reasons on sessions ("Chat unavailable: …") | ✅ | |
| Live chat activity endpoint + UI sparkline | ✅ | Aggregates only |
| Highlight desktop notifications (min score, opt-out) | ✅ | |
| Tests | ✅ | Backend 92 (detection is deterministic across 15 hash seeds); extension 64 |
| Live stack check | ✅ | Built extension + uvicorn: session opens, chat manager tries Kick, the UI shows "Chat unavailable: Kick chat subscription failed: Could not reach Kick" |
| **Real chat from Twitch/Kick** | ⏳ | Needs credentials, a connected Twitch account (`user:read:chat`) or a Kick webhook tunnel, and network access |

**Found and fixed during this phase:** a flaky category result caused by the order language packs
were loaded in (now fixed, with a test that no phrase is ambiguous after normalization).
Repeated common lines ("hi chat") were also creating false candidates; repeated phrases are now
relative to the stream's baseline and can't create a candidate on their own.
## Phase 6 — Clip workflow ✅ (Twitch clip calls pending credentials)

| Item | Status | Notes |
|---|---|---|
| Review: approve / reject / reopen, adjust window and category | ✅ | State machine enforced |
| Twitch Create Clip + confirmation via Get Clips → created / failed with a reason | ✅ | Mocked Helix with processing delay and offline refusal |
| "Moment passed" guard (Twitch clips the current broadcast) with an explicit override | ✅ | 90 s threshold; request lag recorded |
| Auto-capture at detection time (opt-out setting, meets the min score, own token) | ✅ | Never approves or publishes |
| Retry for failed clips | ✅ | |
| Kick manual workflow: instructions, open channel, paste clip URL (validated) | ✅ | Kick has no clip API |
| Title, aspect ratio | ✅ | Stored in StreamHunter (Twitch titles are edited in Twitch's editor via `edit_url`) |
| Export | 🚫 for now | Honest `media_unavailable`; needs an authorized media source (Phase 7) |
| Publish only with explicit confirmation (API and UI) | ✅ | |
| Extension: review actions, clip status on highlights, Clip Library actions, auto-capture toggle | ✅ | |
| Tests | ✅ | Backend 100; extension 68 |
| Live stack check | ✅ | Built extension + uvicorn: Twitch approve → create refused with "Connect your Twitch account…". Kick approve → manual instructions → pasted clip link → export refused honestly → publish after confirmation |

**Found and fixed:** the aspect-ratio selector stretched across the whole clip card; it is now fixed width.
## Phase 7 — VOD & advanced AI 🟡 (core delivered; subtitles and live audio not started)

| Item | Status | Notes |
|---|---|---|
| Twitch VOD discovery + timestamped VOD links on highlights | ✅ | Get Videos (archive), matched to the broadcast start; rechecked every 30 min |
| Kick VOD | 🚫 | No official API |
| Authorized media sources: upload (streamed, size limit) or register (per-user folder), rights confirmation | ✅ | Never downloads from platforms |
| Audio analysis (loudness peaks vs the rolling baseline) | ✅ | Real FFmpeg in tests |
| Visual analysis (scene-change density) | ✅ | |
| Context-aware scoring: chat + audio + visual, renormalized | ✅ | `chat_only_score` kept for transparency |
| Audio-only candidates, candidate merging | ✅ | |
| MP4 export: trim, 9:16 / 1:1 / 16:9, loudness normalization, download | ✅ | |
| Recordings panel per session, analysis status, export progress, download, VOD links | ✅ | |
| Subtitles (speech-to-text) | ⏳ | Needs a local speech model (e.g. faster-whisper, a large download). Reported as `not_implemented` |
| Live tab-audio capture (`chrome.tabCapture` + offscreen document) | ⏳ | Needs extra permissions and a user gesture each time; not started |
| Laughter / excitement classification, gameplay or visual event recognition | ⏳ | Would need ML models; loudness and scene cuts are the honest baseline |
| Tests | ✅ | Backend 109 (incl. 9 real-FFmpeg media tests); extension 71 |
| Live stack check | ✅ | Built extension + uvicorn: uploaded an MP4 via the file picker → FFmpeg analysis (1 audio peak, 2 scene cuts, 2 highlights enriched) → approve → export → downloaded 1080×1920 H.264/AAC, 25.0 s |

**Found and fixed during this phase:**
* Windows outside the recording got a visual score of 0 (lowering their score) instead of "not measured".
* An unreadable upload returned 500 and leaked the server path; it now returns 400 `invalid_media` with the file name only.
* The Clip Library stopped polling an export that took longer than one refresh; it now polls until the export is done.

**Tuning point:** with measured audio, a chat-flagged moment over quiet audio gets a lower combined
score (the specified weights: chat 25 %, audio 30 %, visual 20 %) and may drop below the minimum.
The chat-only score stays visible. Re-weighting needs real-stream data.

## Known platform limitations (by design, not bugs)

| Limitation | Handling |
|---|---|
| 🚫 Kick has no official clip-creation API | `requires_manual_action` |
| 🚫 Kick has no official VOD/media API | `unsupported` |
| Kick chat only arrives through webhooks to a public HTTPS URL | `requires_configuration` until a tunnel or deployment exists |
| A Twitch clip is a link, not a downloadable file | `video_download: not_guaranteed` |
| Monitoring only runs while Chrome is open | Lease expires and sessions pause |

