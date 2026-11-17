# Local-first, search-first migration

Status: in progress (started 2026-11-17). This document is the analysis and the plan. Each step
below lands as its own tested commit, and nothing working is removed until its replacement is tested.

| Step | State |
|---|---|
| 1. Local store and platform clients | ✅ done (88096b0) |
| 2. Discovery page and monitoring list | ✅ done (88096b0) |
| 3. Background monitoring | ✅ done |
| 4. Discovery-mode detection (chat) | ⏳ next |
| 5. Capture mode (rolling buffer, local clips) | ⏳ |
| 6. Clips and Top Highlights on local data | ⏳ |
| 7. Retire the backend | ⏳ |

Not verified against the real APIs yet: no Twitch/Kick app credentials on the development machine.
The clients are tested against a fake that follows the documented request and response shapes.

## 1. Current architecture (before the migration)

```text
Chrome extension (React, MV3)  ──HTTP──►  FastAPI backend (Python)  ──►  SQLite
  popup / side panel / app pages            Twitch Helix + Kick public API (app tokens)
  service worker: heartbeat lease            monitoring engine (polls live status)
  offscreen: tab loudness meter              chat: Twitch EventSub WebSocket, Kick webhooks
                                             detection: chat windows → detectors → score
                                             media: FFmpeg analysis/export, faster-whisper, YAMNet
```

The extension is a thin client. Every page reads `/api/v1/...` through `ApiClient` and the
`useApiQuery` hook. Monitoring, chat detection, highlight scoring, the clip workflow and all media
processing live in Python.

## 2. What is reused

| Today | Reused how |
|---|---|
| Extension pages (Discover, Streamers, Monitoring, Highlights, Clips, Settings), components, tests | Kept. The `ApiClient` interface (`get/post/patch/delete` on `/api/v1/...`) gets a **local implementation** that answers the same paths from IndexedDB and the platform APIs, so most pages keep working and change only where behaviour changes |
| Types in `src/types/api.ts` (Streamer, HighlightCandidate, Clip, Page) | Kept as the local data model |
| Service worker + `chrome.alarms` + `monitoring-manager` (backoff, badge, notifications) | Kept. The alarm now runs the live-status check itself instead of a backend heartbeat |
| Offscreen document + tab capture + loudness meter + PCM tap | Kept and extended to video: capture mode records the tab (WebCodecs) |
| Twitch/Kick clients (Python) | Ported to TypeScript (same endpoints, same batching and rate-limit rules) |
| Chat detection (`window.py`, detectors, lexicon, scoring: ~800 lines of Python) | Ported to TypeScript with the same tests' scenarios |
| Audio peak and visual event logic (Python, FFmpeg) | Ported to TypeScript and run on the live capture (Web Audio, canvas frames) |
| FFmpeg export, faster-whisper subtitles, YAMNet in Python | **Not portable** to a backend-free extension. They stay in the old backend until it is retired. Clips are cut from the capture buffer instead (no re-encode). Subtitles and laughter detection have no in-browser replacement yet (see §5) |

## 3. How Twitch and Kick are supported (no backend)

Each editor uses **their own** developer app credentials, entered once in Settings and stored in
`chrome.storage.local`. An extension can't keep a shared secret, and a shared app would share one
rate limit across all users. The extension calls the APIs directly; host permissions make this
possible without CORS.

| Feature | Twitch | Kick |
|---|---|---|
| Credentials | Client ID + secret → app access token (client credentials) for search and live status. Optional "Sign in with Twitch" (`chrome.identity.launchWebAuthFlow`, implicit grant, `user:read:chat`) for chat | Client ID + secret → app access token (`id.kick.com`, client credentials) |
| Search by username | `GET /helix/search/channels?query=` (fuzzy, live first) | No search endpoint: exact slug lookup `GET /public/v1/channels?slug=` |
| Discover live streamers | `GET /helix/streams` (top live, optional game/language) | `GET /public/v1/livestreams` (sort by viewers, optional category) |
| Live status of saved streamers | `GET /helix/streams?user_id=` (100 per request) | `GET /public/v1/channels?slug=` (50 per request) |
| Title, category, viewers, avatar | streams + users (`profile_image_url`) | channel (`stream_title`, `category`, `stream.viewer_count`) + users (`profile_picture`) |
| Chat in the background (discovery mode) | EventSub **WebSocket** `channel.chat.message`, held by the offscreen document, which needs the user's Twitch sign-in | **Not available.** Kick delivers chat events only through webhooks to a public HTTPS server. Discovery mode for Kick uses viewer-count changes only |
| Capture mode | Any Twitch tab the user opens and authorizes | Any Kick tab the user opens and authorizes |

## 4. API restrictions and Chrome limits

* **Rate limits.** Twitch: 800 points per minute per app token. Kick: not published, so the extension
  backs off on 429. Live status is batched (one request per 100 Twitch / 50 Kick streamers), runs
  at most once a minute (default every 2 minutes), and backs off exponentially on errors.
* **Service-worker lifetime.** `chrome.alarms` fires at most every 30 s and the worker sleeps in
  between, so status checks are alarm-driven and stateless (state in storage). A chat WebSocket
  can't live in the worker. It lives in the offscreen document, which Chrome allows while it has a
  reason (`USER_MEDIA` during capture; `WORKERS`/`BLOBS` otherwise, re-created when needed).
* **Chrome must be open.** Nothing runs while Chrome is closed (unchanged).
* **Capture needs a click.** `tabCapture` only works after the user invokes the extension on that
  tab. A detected moment can only *notify* and offer "Open stream". Recording starts when the
  user clicks Capture on the open tab.
* **No retroactive video.** Discovery mode finds *provisional* highlights (chat or metadata only).
  They are labelled as such and never offered as downloadable clips. Clips exist only for moments
  that happen while a capture's rolling buffer is running.
* **Storage.** Clips are stored in IndexedDB (`navigator.storage.persist()` requested). A
  rolling buffer of about 2 minutes at 720p stays in memory (about 40–60 MB). Old clips can be
  deleted from the Clips page.
* **Formats.** WebCodecs H.264 + AAC (or Opus) muxed to MP4 in the browser, cut on keyframes
  (encoded with a keyframe every 2 s, so cuts are within 2 s). No re-encode, no aspect-ratio reframing.
* **Kick chat, Twitch clips API.** No official background chat for Kick (see above). Creating
  *Twitch* clips through Helix needs a user token with `clips:edit` and doesn't give a file. It
  stays an optional action once Twitch sign-in exists.

## 5. Migration plan (incremental)

1. **Local store and platform clients.** IndexedDB (`streamers`, `sessions`, `highlights`,
   `clips`, `clipBlobs`), credentials in Settings, TypeScript Twitch/Kick clients with app tokens,
   batching and backoff, and the `LocalApi` that answers the existing `/api/v1/...` paths.
2. **Discovery page and monitoring list** on `LocalApi`: search, platform filter, live/offline,
   title, category, viewers, avatar, add to list, open stream.
3. **Background monitoring.** The alarm checks saved streamers, records live/offline transitions as
   sessions, notifies, and shows status and last update on the Monitoring page.
4. **Discovery-mode detection.** Port the chat detectors and scoring to TypeScript. Twitch chat
   comes over EventSub WebSocket in the offscreen document after Twitch sign-in. Kick uses
   viewer-count spikes. The result is provisional highlights with a score, a notification and
   **Open stream**.
5. **Capture mode.** Start/stop capture from the popup on a stream tab. Offscreen: tab video +
   audio → WebCodecs encoders → rolling buffer; loudness and visual-change detection live;
   chat-detected moments for that streamer also cut clips. Clip = buffer window → MP4 → IndexedDB.
6. **Clips and Top Highlights on local data.** Download and delete clips, ranked by score.
   Provisional highlights stay clearly marked without video.
7. **Retire the backend.** Once every page runs on `LocalApi` and the tests cover it: remove
   `backend/`, the backend URL setting, sign-in and the heartbeat. Update README, ARCHITECTURE,
   SECURITY and IMPLEMENTATION_STATUS.

Lost with the backend (documented, no in-browser replacement for now): FFmpeg reframing to
9:16/1:1, burned-in subtitles (faster-whisper) and YAMNet laughter detection. Uploading an
existing recording for analysis also goes; clips come from captures.
