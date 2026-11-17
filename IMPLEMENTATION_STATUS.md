# StreamHunter — Implementation Status

_Last updated: 2026-11-17_

Legend: ✅ done & verified · 🟡 partial · ⏳ not started · 🚫 not possible with official APIs

## v1.0 — Local-first, search-first ✅ (current)

No backend: one Chrome extension, data in IndexedDB, Twitch/Kick called directly with the editor's
own developer apps. Plan and API analysis: [docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md).

| Item | Status | Notes |
|---|---|---|
| Local store (IndexedDB) + local API with the pages' existing paths | ✅ | `src/local/`. Unknown paths are a local 404; nothing is fetched from a server |
| Twitch Helix / Kick public API clients, editor's own app credentials | ✅ tested against a fake | Settings → Platforms, Save and test. Token cache, one retry after 401, 429 waits honoured, batching 100 / 50 |
| Discover: search, Twitch/Kick filter, live now, viewers, category, avatar, Add, Open stream | ✅ | Kick: exact channel name (no search API) |
| Background monitoring: alarm → batched status check → sessions → notifications | ✅ | Degraded/offline states name the platform and reason. Pause on stop, resume the same broadcast |
| Chat detection ported to TypeScript (same rules and scenarios as the backend's tests) | ✅ | 17 tests on a seeded chat simulator |
| Twitch chat via EventSub WebSocket + Sign in with Twitch | ✅ tested against a fake socket | Subscribe per live streamer, unsubscribe when offline, refusal reported. **Not yet run against real Twitch** (needs credentials) |
| Kick chat | 🚫 | Official delivery is webhooks to a public server only |
| Viewer-spike highlights (Twitch and Kick) | ✅ | ≥ 1.5× and +100 over the broadcast's median |
| Provisional highlights with Open stream notifications | ✅ | Labelled "provisional · no video" everywhere |
| Capture mode: tab video/audio → WebCodecs → 2-min rolling buffer → MP4 clips in IndexedDB | ✅ verified in Chrome | See below |
| Live capture signals: loudness, fast action, flashes → automatic clips; chat/viewer highlights of the captured streamer clip too; Save last 30 s | ✅ | |
| Top Highlights (ranked, video filter) and Clip Library (preview, rename, download MP4, delete) | ✅ | |
| Retention of provisional highlights and ended sessions | ✅ | Clips are kept until deleted |
| Backend removed | ✅ | `backend/` deleted; in git history before the v1.0 commit |
| Tests | ✅ | Extension 92 (local API, platform clients, monitoring, chat manager, detection, capture buffer/mux/signals, capture manager, UI) |
| Real-Chrome check | ✅ | Chrome 157, built extension loaded unpacked, a tab playing a test video (moving test pattern, quiet tone, a real laugh at 40 s). **Save last 12 s** → a 12.1 s MP4, H.264 1280×720 302 frames + AAC 48 kHz stereo, decodes cleanly with FFmpeg, frame shows the tab. **Automatic**: after 30 s of learning, the laugh was detected ("Stream audio 21 dB louder than usual") and a 30.0 s clip saved by itself, the laugh at 18–27 s of it. The pan and the flash alone stayed below the minimum score, as designed |

**Found and fixed during the check:** capturing a static tab gives no video frames (Chrome only
produces frames when the page changes); the test harness had picked the blank start tab.

**Not verified yet:** real Twitch and Kick API responses and real Twitch chat (no app credentials on
the development machine). The request and response shapes follow the platform documentation.

## History: backend era (Phases 0–7, retired in v1.0)

Everything below was built with a FastAPI backend, which v1.0 replaced. Features that have no
in-browser equivalent were removed: accounts, Twitch clip creation through the API, uploading
recordings for analysis, FFmpeg exports with 9:16 reframing, burned-in subtitles (faster-whisper)
and YAMNet laughter detection.

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
## Phase 7 — VOD & advanced AI ✅ (recordings, subtitles, live tab audio, laughter in recordings and live, on-screen events)

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
| Subtitles (speech-to-text) | ✅ | faster-whisper, local CPU (optional `requirements-media.txt`). Burned into the export in the same encode, plus a downloadable .srt. Short lines for vertical video. Language detected or chosen |
| Bundled FFmpeg fallback | ✅ | `static-ffmpeg` (optional) is used automatically when `ffmpeg` isn't on PATH |
| Live tab audio (`chrome.tabCapture` + offscreen document) | ✅ | Started from the popup on the stream tab (Chrome needs that click). One RMS loudness value per second → `POST /monitoring/audio` → live highlights get a measured audio signal. Permissions `activeTab`, `tabCapture`, `offscreen` |
| Laughter / cheering / screaming in recordings | ✅ | YAMNet (AudioSet) via LiteRT, local CPU (optional `requirements-media.txt`); model fetched once and SHA-256 checked. Two windows per second (0.5 s hop), a kind = its classes summed and capped at 1; audio streamed from FFmpeg. Audio signal = max(loudness, sound); a clear sound (≥ 45%) names unnamed moments (laughter → funny, cheering → exciting, screaming → unexpected reaction); sound-only highlights; `laughter`/`cheering`/`screaming` stream events. A classifier failure doesn't fail the analysis |
| Live laughter / cheering / screaming (opt-in) | ✅ | Popup checkbox, off by default. Offscreen AudioWorklet → 16 kHz mono (box-filter downsampling) → 5 s batches with 1 s overlap inside `POST /monitoring/audio` → same YAMNet model on the backend, in memory, audio dropped. Live highlights: audio = max(loudness, sound), clear sound names the category, reason "Laughter in the audio (…% match)". Popup shows "Hearing laughter 90%" |
| On-screen events in recordings | ✅ | FFmpeg `signalstats` 4×/s (brightness, motion). Fast action (≥ 2.5× the recording's usual motion, ≥ 8/255, ≥ 2 s; per-second median so a hard cut isn't action) and flashes (brightness +50 and back within 1.5 s; a cut to a bright scene isn't one). Visual = max(cut density, motion score). Names unnamed highlights `gameplay_highlight`; new highlights only with audio ≥ 40; `fast_action` / `screen_flash` events |
| Recognising specific game events (kills, wins, scoreboards) | 🚫 generic | Needs a model per game; the on-screen detector is game-agnostic |
| Tests | ✅ | Backend 136 + 3 that use the real sound model when `SOUND_MODEL_DIR` points to it (incl. real-FFmpeg on-screen events); extension 101 (downsampling, overlapping batches, opt-in flow). Earlier count: backend 129 + 2 (incl. real-FFmpeg media and subtitle tests; speech and sound models are faked otherwise); extension 94 |
| Live stack check | ✅ | Built extension + uvicorn: uploaded an MP4 via the file picker → FFmpeg analysis (1 audio peak, 2 scene cuts, 2 highlights enriched) → approve → export → downloaded 1080×1920 H.264/AAC, 25.0 s. Subtitles (2026-11-16): real `base` model on a spoken test recording → accurate 2-cue .srt in 3.9 s, captions visible in the 1080×1920 export; Clip Library switch → export → Download .srt in the browser preview. Sound model (2026-11-17): speech → Speech 0.99, sine → Sine wave 0.92, a synthetic "ha ha" voice → no laughter. Real recordings (Wikimedia Commons, CC BY; not in the repo): three laughter clips → laughter 100% / 51% (named funny) and 41% (event recorded, not named); crowd laughing and applauding → cheering 99%; speech, robot "ha ha" and tones stay at 0–3%. Taking only the single best class from one window per second missed two of the three laughs, so a kind now sums its classes and checks every 0.5 s. Full analysis on the live backend: a 70 s recording with talking and a real laugh at 40 s → laughter 40–48 s; a chat "audience reaction" over it became a funny moment ("Laughter in the audio (100% match)"), and without chat a new funny moment was created. A laugh mixed under louder speech was missed (documented limitation) Live laughter (2026-11-17): real Chrome 157 with the built extension, tab capture of a page looping a real laughter recording, sound detection ticked → every 5 s batch answered `sound_state: receiving` with laughter 65–100% (cheering ≤ 2%, screaming ≤ 14%); the same model on the live path, replayed in 5 s batches with 1 s overlap, gives the same peaks as recordings (100% / 51% / 41%). On-screen events: real FFmpeg test video → burst of noise found as fast action (14.9× usual motion), a 0.3 s white flash found, a single hard cut ignored |

**Found and fixed during this phase:**
* Windows outside the recording got a visual score of 0 (lowering their score) instead of "not measured".
* An unreadable upload returned 500 and leaked the server path; it now returns 400 `invalid_media` with the file name only.
* The Clip Library stopped polling an export that took longer than one refresh; it now polls until the export is done.
* faster-whisper 1.2.1 can't decode files with the current PyAV (19); StreamHunter now passes it the samples FFmpeg already decoded.
* SQLAlchemy didn't install `greenlet` on Apple Silicon (`sqlalchemy[asyncio]` now), and a chat test depended on the time of day.

**Tuning point:** with measured audio, a chat-flagged moment over quiet audio gets a lower combined
score (the specified weights: chat 25 %, audio 30 %, visual 20 %) and may drop below the minimum.
The chat-only score stays visible. Re-weighting needs real-stream data.

## Known platform limitations (by design, not bugs)

| Limitation | Handling |
|---|---|
| 🚫 Kick delivers chat only via webhooks to a public HTTPS server | Kick chat shown as unavailable; Kick uses live status and viewer spikes |
| 🚫 Kick has no search API | Exact channel name lookup |
| Tab capture needs the editor's click on that tab | Detections notify with Open stream; capture is started from the popup |
| Video exists only for captured streams | Provisional highlights are labelled and never offered as clips |
| Monitoring only runs while Chrome is open | Sessions pause on stop and resume within the same broadcast |
