# StreamHunter — Architecture

> Find the moment. Create the clip.

This document describes how StreamHunter is put together and — just as important —
what the Twitch and Kick platforms do and do **not** allow. Everything in the
"Platform capabilities" section is the basis for the capability flags the product
reports to the user. Nothing in the product may claim more than is listed here.

---

## 1. System overview

```text
┌──────────────────────────── Chrome (Manifest V3) ────────────────────────────┐
│                                                                              │
│  Popup (control center)   Full page / Side panel (editor workspace)          │
│          │                         │                                         │
│          └──── chrome.runtime messages ────┐                                 │
│                                            ▼                                 │
│                     Background service worker (ephemeral)                    │
│                     • alarm-manager   (chrome.alarms)                        │
│                     • monitoring-manager (state in chrome.storage.local)     │
│                     • message-handler (typed request/response)               │
│                     • heartbeat → backend lease                              │
└────────────────────────────────────────┬─────────────────────────────────────┘
                                         │ HTTPS REST /api/v1 + WS /ws/monitoring
                                         ▼  (bearer token of the StreamHunter user)
┌──────────────────────────────── FastAPI backend ─────────────────────────────┐
│  api/routes ── services ── models (SQLAlchemy 2, SQLite → PostgreSQL)        │
│        │                                                                     │
│        ├── integrations/  (platform adapters, capability reporting)          │
│        │      ├── twitch/  Helix REST + EventSub WebSocket (chat, online)    │
│        │      └── kick/    Public API v1/v2 + signed webhooks (chat, status) │
│        ├── monitoring/   lease manager, scheduler, session lifecycle         │
│        ├── detection/    chat window aggregator + detectors + scoring        │
│        └── clipping/     clip state machine, platform clip requests,         │
│                          (future) authorized media export via FFmpeg         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Responsibilities

| Layer | Owns | Never does |
|---|---|---|
| Extension | UI, user intent (start/stop), scheduling heartbeats, showing truthful status | Hold platform client secrets or platform OAuth tokens |
| Backend | Platform API calls, OAuth token exchange & encrypted storage, chat ingestion, detection, persistence, clip requests | Monitor after the browser lease has expired |
| Detection engine | Platform-independent scoring from normalized `ChatMessage`/`StreamEvent` objects | Import platform-specific code |

---

## 2. Browser-based monitoring model (lease)

Manifest V3 service workers are suspended after ~30 s of inactivity, so the extension
cannot run a permanent loop. The design:

1. **State lives in `chrome.storage.local`** (`monitoring` key): enabled flag, last
   heartbeat result, last error, consecutive failures, next backoff time.
2. **`chrome.alarms`** drives work. `sh-heartbeat` fires every *N* minutes
   (configurable, minimum 1 — Chrome enforces ≥30 s for packed extensions).
3. Every alarm tick the worker re-reads state from storage (it may have been
   restarted) and calls `POST /api/v1/monitoring/heartbeat`.
4. The backend grants a **lease** (`expires_at = now + lease_ttl`, default 3× the
   heartbeat interval). While the lease is valid the backend polls live status for
   the user's watchlist and keeps chat collectors open.
5. When the lease expires (browser closed, laptop asleep, extension disabled) the
   backend **stops** chat collectors and marks sessions `paused`. It does not keep
   monitoring in the cloud.
6. `chrome.runtime.onStartup` / `onInstalled` re-create alarms and resume if
   monitoring was enabled. Failed heartbeats back off exponentially
   (1, 2, 4 … capped at 15 min) and the UI shows `degraded`/`offline` truthfully.

**Implemented (Phase 4):** `backend/app/monitoring/`. `engine.py` handles the lease, poll cycle and
per-platform backoff, `reconciler.py` holds the session rules, `scheduler.py` is an asyncio loop in the
API process, and `retention.py` is the sweep. The extension sends `since` (the backend clock at the
previous heartbeat) so "went live" notifications are delivered once. A Redis/Celery worker can replace
the in-process scheduler without changing the engine API.

Monitoring states shown to the user: `stopped`, `starting`, `active`, `degraded`
(backend reachable but errors), `offline` (backend unreachable), `paused`.

---

## 3. Platform capabilities (verified research, 2026-11-13)

### How this was verified

* **Kick**: read from the official `KickEngineering/KickDevDocs` repository on
  GitHub (source of docs.kick.com). `docs.kick.com` and `api.kick.com` were not
  reachable from the development container, so request/response field names that
  only exist in the OpenAPI spec (`https://api.kick.com/swagger/doc.yaml`) are
  **unverified** and must be confirmed when credentials and network access exist.
* **Twitch**: `dev.twitch.tv` was not reachable from the development container.
  The Twitch facts below come from established Helix/EventSub documentation as
  known before this session and are marked *unverified this session*. They must
  be re-checked against https://dev.twitch.tv/docs before enabling each feature.

### Kick (official public API)

| Item | Finding |
|---|---|
| OAuth server | `https://id.kick.com` — `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/token/introspect` |
| Flow | Authorization code **with PKCE (S256)**; `state` required |
| Client secret | **Required** for code exchange and refresh → exchange must happen on the backend |
| App token | `client_credentials` grant exists (needs secret) |
| Scopes | `user:read`, `channel:read`, `channel:write`, `channel:rewards:read/write`, `chat:write`, `streamkey:read`, `events:subscribe`, `moderation:ban`, `moderation:chat_message:manage`, `kicks:read`, `ads:read/write` |
| API base | `https://api.kick.com/public/v1/…` and `/public/v2/…` |
| Channel lookup | `GET /public/v1/channels` (lookup by slug added 2025-04-08; param name unverified) |
| Livestreams | `GET /public/v2/livestreams`, `GET /public/v1/livestreams`, `/public/v1/livestreams/stats` |
| Users / categories | `GET /public/v1/users`, `GET /public/v1/categories[/{id}]`, `/public/v2/categories` |
| **Reading chat** | Only via **webhook** event `chat.message.sent` (subscribe with `POST /public/v1/events/subscriptions`). No official WebSocket or polling read API |
| Status events | `livestream.status.updated`, `livestream.metadata.updated` (webhook) |
| Webhook delivery | Kick POSTs to a **public HTTPS URL** configured in the Kick app settings. Local development needs a tunnel (e.g. Cloudflare Tunnel / ngrok) |
| Webhook security | RSA PKCS#1 v1.5 + SHA-256 over `message_id.timestamp.body`, base64 in `Kick-Event-Signature`; public key from `GET /public/v1/public-key` (do not hardcode) |
| **Clip creation** | **No official API** → `requires_manual_action` |
| **VOD / video** | **No official endpoint** → `unsupported` |
| Rate limits | Not documented |

**Phase 3 verification update (2026-11-15):** the Kick OAuth parameters above were re-read from
the docs source (`getting-started/generating-tokens-oauth2-flow.md`). Kick's per-endpoint field names
live only in the OpenAPI spec, which was still unreachable, so `app/integrations/kick/schemas.py`
parses them defensively and documents them as unverified. Twitch `Get Users` / `Get Streams` fields
were checked against the official `twitchdev/twitch-cli` mock API source. The opt-in tests in
`tests/integration/` confirm everything against the live APIs once credentials exist.

### Twitch (Helix + EventSub) — *partially verified (see above)*

| Item | Finding |
|---|---|
| OAuth | `https://id.twitch.tv/oauth2/authorize`, `/token`, `/validate`, `/revoke`. Authorization-code flow needs the client secret → backend exchange. Tokens must be validated hourly via `/validate` |
| App token | Client credentials — enough for Search Channels, Get Users, Get Streams |
| Search | `GET /helix/search/channels?query=` → `id`, `broadcaster_login`, `display_name`, `is_live`, `game_name`, `title`, `thumbnail_url`, `started_at` |
| Users / Streams | `GET /helix/users?login=`, `GET /helix/streams?user_id=` (`viewer_count`, `started_at`, `game_name`, `title`, `type`) |
| Chat read | EventSub **WebSocket** (`wss://eventsub.wss.twitch.tv/ws`) subscription `channel.chat.message` v1, user token with `user:read:chat`, condition `{broadcaster_user_id, user_id}`. Messages include emote fragments. IRC remains as legacy |
| Online/offline | EventSub `stream.online` / `stream.offline` (or Get Streams polling) |
| Clip creation | `POST /helix/clips?broadcaster_id=` with `clips:edit`; asynchronous — returns `id` + `edit_url`, then confirm with `GET /helix/clips?id=`. Only while live and if the channel allows clips |
| Clip download | Not guaranteed. Any official download endpoint is restricted to broadcaster/editor roles → `video_download: not_guaranteed` |
| VODs | `GET /helix/videos?user_id=` gives metadata/URL; no general media download → `vod_analysis: conditional` (metadata only) |
| Rate limits | Token-bucket, reported in `Ratelimit-*` headers; honour them |

### Resulting capability matrix (defaults before authorization)

| Capability | Twitch | Kick |
|---|---|---|
| stream_lookup | requires app credentials | requires app credentials |
| live_detection | yes (poll / EventSub) | yes (poll / webhook) |
| category_lookup | yes | yes |
| chat_monitoring | yes, with user OAuth (`user:read:chat`) | **requires public webhook URL** + `events:subscribe` |
| official_clip_creation | yes, with `clips:edit`, live only | **requires_manual_action** |
| vod_analysis | conditional (metadata only) | unsupported |
| video_download | not_guaranteed | unsupported |

Capabilities are computed at runtime by each adapter from configuration and the
user's connection state (`GET /api/v1/platforms/capabilities`), not hardcoded in the UI.

### Explicitly out of bounds

* Kick's undocumented Pusher WebSocket for chat, scraping channel pages, or any
  unofficial clip/VOD downloader (e.g. yt-dlp against platform media).
* Capturing tab audio/video without an explicit user gesture and Chrome's
  `tabCapture`/`offscreen` permission flow (future, opt-in only).

---

## 4. Timestamps

* All stored timestamps are UTC. API boundaries use timezone-aware ISO 8601.
* `stream_offset_sec` is computed as `event_time − stream.started_at` **only** when
  the platform reports `started_at`; it is labelled *approximate* because broadcast
  delay and ingestion latency are unknown. If `started_at` is missing, the offset
  is `null` — never guessed.

---

## 5. Detection engine (platform-independent)

```text
ChatMessage stream ─► RollingWindow (e.g. 10 s buckets, 5 min baseline)
                       │   per-window: messages, unique users (per-user cap),
                       │   emote counts, keyword hits, clip requests
                       ▼
     Detectors: chat_spike · emote · keyword · reaction  ──► DetectorEvent
                       ▼
               event_aggregator (merge events within a cooldown window)
                       ▼
               scoring_engine (renormalized weights over available signals)
                       ▼
               HighlightCandidate {score 0–100, confidence, reasons,
                                   signal_breakdown, category, suggested window}
```

**Implemented (Phase 5):** `backend/app/detection/` (platform independent) and
`backend/app/monitoring/chat_manager.py` (collectors + persistence).

* 5 s buckets, a 15 s analysis window, and a 5 min baseline per stream. Relative detection
  needs at least 30 s of history ("warming up" before that).
* Detectors: `chat_spike` (z-score and ratio vs the stream's own baseline), `emote_wave` and
  `repeated_phrase` (both must be ≥ 2× their usual rate), `clip_request` ("clip it", multilingual),
  `reaction` (8 language packs + custom phrases) and `sentiment_shift`. Repeated phrases and
  sentiment shifts only *support* a moment; one of the first four must fire.
* Every detection records the strictest sensitivity level it passes (low / medium / high). Each
  user only gets candidates that pass their own sensitivity, while one shared analyzer serves
  all users watching the same streamer.
* Aggregator: a moment extends while events keep coming (≤ 10 s gaps, ≤ 90 s total), then
  becomes one candidate (score floor 35); there is a 20 s cooldown after it.
* Candidate window = moment ± the user's pre-roll / post-roll. Offsets are relative to the
  platform's broadcast start, labelled approximate, and `null` when the start is unknown.
* Chat collection: Twitch EventSub WebSocket (one connection per authorizing user;
  keepalive, reconnect, revocation handled). Kick signed webhooks (RSA verified, ±5 min, replay
  protected), subscribed and unsubscribed per channel with the app token. When chat can't be
  collected, the reason is written to the session and shown in the UI.

Rules carried over from the design:

* Spikes are measured as a z-score / ratio against the stream's own rolling
  baseline, not a global threshold.
* Each user's contribution per window is capped so one spammer ≠ an audience.
* Keyword/reaction lists are configurable per language.
* Missing audio/visual signals are excluded and the remaining weights renormalized.

---

## 5b. Post-stream analysis and export (Phase 7)

```text
user-provided recording (upload / register, rights confirmed)
      │ ffprobe
      ▼
media_sources ──analyze job──► loudness per second (astats) + scene changes (select/showinfo)
      │                              │
      │                              ├─ enrich covered highlights: score = renormalized(chat, audio, visual)
      │                              ├─ audio-only peaks (≥ 6 dB over the 2-min rolling median, ≥ 2 s) → origin "vod"
      │                              └─ merge overlapping pending highlights
      └──export job──► trim [start,end] − offset_in_stream → crop/pad 9:16 | 1:1 | 16:9 → loudnorm → MP4
Twitch Get Videos (archive) ──► session.vod_url ──► highlight.vod_url_at (?t=…, approximate)
```

`offset_in_stream_sec` maps file time to stream time (0 for a full VOD). Audio "excitement" is
loudness relative to the recording's own baseline; it can't tell laughter from shouting, so
audio-only highlights are categorized `unknown`. Subtitles (speech-to-text) and live tab-audio
capture are not implemented.

## 6. Clip state machine

```text
detected → pending_review → approved → creation_requested → created → exporting → ready → published
                │              │              │                 │            │
                └→ rejected    └→ unsupported └→ failed ←───────┴────────────┘
failed → creation_requested (retry)
```

`published` is reachable only from `ready`/`created` through an explicit user
confirmation endpoint. StreamHunter never publishes anywhere by itself; “published”
is a manual flag the editor sets.

---

## 7. Security

* Platform secrets only in backend environment variables.
* Platform tokens encrypted at rest (Fernet, key from `TOKEN_ENCRYPTION_KEY`).
* Extension stores only the StreamHunter session token and non-secret settings.
* All resources are scoped to the authenticated user; ownership is checked in
  the service layer.
* Kick webhooks are rejected unless the RSA signature verifies and the timestamp
  is recent; duplicate message IDs are ignored.

See `SECURITY.md` (Phase 2) for the full policy.
