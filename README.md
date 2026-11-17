# StreamHunter

**Find the moment. Create the clip.**

StreamHunter is a Chrome extension for video editors and clipping teams. It watches
Twitch and Kick streamers while your browser is open, reads chat to spot moments
when the audience reacts, explains *why* each moment was flagged, and helps you turn
it into a clip. Nothing is ever published without your approval.

> **Status:** Phases 0–6 (the MVP) are built. You can monitor streamers, detect highlights from chat, and
> review them; Twitch clips are created (automatically at detection, or on request) and Kick clips
> go through a guided manual step. Publishing always needs your confirmation. Everything is tested
> against simulated chat and mocked platform APIs; real platform use needs your credentials.
> See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

![Overview](docs/screenshots/app-overview.png)

## Features

| | Status |
|---|---|
| MV3 extension: popup, full-page workspace, side panel | ✅ |
| Settings (monitoring interval, sensitivity, score threshold, languages, clip defaults, notifications, time zone, retention) | ✅ |
| Browser-based monitoring: backend lease, scheduled batched polling, sessions open/pause/resume/end, restart recovery | ✅ |
| "Streamer went live" desktop notifications (opt-in) | ✅ |
| Backend: accounts (Argon2, revocable sessions), watchlist API, settings API, capability reporting | ✅ |
| Twitch search, Kick exact-name lookup, live status, title & category | ✅ (needs credentials) |
| Connect Twitch / Kick accounts (OAuth; PKCE for Kick; tokens encrypted) | ✅ (needs credentials) |
| Chat-based highlight detection with explainable scores (spikes, emotes, clip requests, reactions in 8 languages, sentiment) | ✅ |
| Live chat activity per session, highlight notifications | ✅ |
| Review workflow (approve / reject / reopen), Twitch clip creation (auto-capture or on request), Kick manual clip step | ✅ (Twitch needs credentials) |
| Publish only after explicit confirmation | ✅ |
| Twitch VOD links at each highlight's timestamp | ✅ (needs credentials) |
| Post-stream analysis of your own recordings: audio peaks, scene changes, combined scoring, merging | ✅ (needs FFmpeg) |
| MP4 export: 9:16 / 1:1 / 16:9, loudness-normalized | ✅ (needs FFmpeg + your recording) |
| Subtitles: local speech-to-text, burned into the MP4 + downloadable .srt | ✅ (needs the optional media extras) |
| Laughter, cheering and screaming in your recordings (local sound classifier) name and score highlights | ✅ (needs the optional media extras) |
| Live tab audio: the stream's loudness from your open Twitch/Kick tab joins live highlight detection | ✅ (start it from the popup) |
| Live laughter and cheering from that tab (opt-in) name and score live highlights | ✅ (needs the optional media extras) |
| On-screen events in recordings: bursts of fast action and sudden flashes | ✅ (needs FFmpeg) |

## Technology

* **Extension:** Chrome Manifest V3, React 19, TypeScript (strict), Vite 7, Tailwind CSS 4, Lucide icons
* **Backend:** Python 3.12+, FastAPI, Pydantic, SQLAlchemy 2, Alembic, SQLite → PostgreSQL, HTTPX, Pytest

## Requirements

* Node.js 20+ and npm 10+
* Google Chrome 116+ (or another Chromium browser)
* Python 3.12+ (backend)
* FFmpeg with ffprobe (optional; needed only for recording analysis and MP4 export). No system
  FFmpeg? `requirements-media.txt` installs one into the backend's virtual environment.

## Install & build the extension

```bash
cd extension
```

```bash
npm ci
```

```bash
npm run build
```

The built extension is written to `extension/dist/`.

### Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist`.
4. Pin StreamHunter in the toolbar. The full workspace opens automatically on first install.

### Develop

```bash
npm run dev
```

This rebuilds `dist/` on every change. Click the reload icon on the extension card
in `chrome://extensions` to pick up service worker or manifest changes.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The tests use an in-memory fake of the Chrome APIs (`src/test/fake-chrome.ts`). They
cover settings validation, storage persistence, the API client, the monitoring state
machine (backoff, recovery, restore after restart), service worker wiring and
messaging, and rendering of the popup, workspace and side panel.

## Run the backend

From the repository root, create a virtual environment:

```bash
cd backend && python3 -m venv .venv
```

Install the dependencies (including the test tools):

```bash
.venv/bin/pip install -r requirements-dev.txt
```

Create your local configuration and the database:

```bash
cp ../.env.example .env
```

```bash
.venv/bin/alembic upgrade head
```

Start the API:

```bash
.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

* Health: http://localhost:8000/health
* Interactive API docs: http://localhost:8000/docs

Then open the extension, go to **Settings → Account** and create an account. Your watchlist,
highlights and clips belong to that account.

Run the backend tests:

```bash
.venv/bin/python -m pytest
```

## Twitch & Kick setup

* **Twitch:** create an app at https://dev.twitch.tv/console/apps, set the redirect URI
  to `http://localhost:8000/api/v1/auth/twitch/callback`, and put `TWITCH_CLIENT_ID` and
  `TWITCH_CLIENT_SECRET` in `backend/.env`.
* **Kick:** create an app in Kick's developer settings and set the redirect URI to
  `http://localhost:8000/api/v1/auth/kick/callback`. Put `KICK_CLIENT_ID` and
  `KICK_CLIENT_SECRET` in `backend/.env`. Chat monitoring also needs a **public HTTPS
  webhook URL** (`KICK_WEBHOOK_PUBLIC_URL`, for example a Cloudflare Tunnel), because Kick delivers chat
  only through webhooks.

* **Chat:** Twitch chat needs a connected Twitch account (Settings → Platform connections; it
  asks for `user:read:chat`). Kick chat needs a public HTTPS URL that forwards to your backend.
  For example, run a free Cloudflare Tunnel with this command:

  ```bash
  cloudflared tunnel --url http://localhost:8000
  ```

  Then set `KICK_WEBHOOK_PUBLIC_URL` to the tunnel URL and register
  `<tunnel URL>/api/v1/webhooks/kick` as the webhook URL in your Kick app settings.
* **Encryption key:** set `TOKEN_ENCRYPTION_KEY` in `backend/.env` (the command to generate one is in
  `.env.example`). Without it, accounts cannot be connected, because tokens are only stored encrypted.

Restart the backend, then use **Settings → Platform connections → Connect account**. Searching
and live status only need the client ID and secret; connecting an account is needed for chat (Phase 5)
and Twitch clips (Phase 6).

Without these, **Settings → Platform connections** shows exactly what is missing.

Verify your credentials against the live APIs (optionally set `SH_TWITCH_LOGIN` / `SH_KICK_SLUG`):

```bash
set -a; . ./.env; set +a; .venv/bin/python -m pytest -m integration -v
```

## Recordings, analysis and export

StreamHunter never downloads streams. To analyse a broadcast after it ends, or to export MP4s,
attach a recording you own, for example a VOD you downloaded from your own dashboard:

1. **Live Monitoring → (ended session) → Recording & analysis → Upload recording.** Tick the
   rights confirmation. If the file doesn't start at the beginning of the stream, enter the stream
   second where it starts.
2. Click **Analyze**. Highlights gain measured audio and visual signals, strong loud moments chat
   missed are added, and overlapping highlights are merged. With the media extras installed,
   StreamHunter also listens for **laughter, cheering and screaming**: a highlight with clear
   laughter becomes a *funny moment* ("Laughter in the audio (80% match)"), and laughs or cheers
   chat missed become new highlights. The result line says what was heard. StreamHunter also
   watches the picture: a burst of much more movement than the recording usually has ("Fast
   on-screen action (3.2× the usual motion) for 6 s") or a sudden flash (explosions, flashbangs)
   makes an unnamed highlight a *gameplay highlight*. A screen event on its own only becomes a new
   highlight when the audio reacts too, because games flash and move all the time.
3. In the **Clip Library**, choose an aspect ratio and click **Export MP4**, then **Download MP4**.
   Turn on **Subtitles** first to transcribe the speech and burn captions into the video; the
   captions are also available as **Download .srt**.

### Optional media extras (FFmpeg, subtitles, laughter detection)

From `backend/`:

```bash
.venv/bin/pip install -r requirements-media.txt
```

This adds a bundled FFmpeg (used automatically when `ffmpeg` isn't on your PATH) and
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) for speech-to-text. Transcription runs
on your machine; audio is never sent anywhere. The first subtitled export downloads the speech
model once (`WHISPER_MODEL`, default `base`, about 145 MB) into `media/models`. Larger models
(`small`, `medium`, `large-v3`) are more accurate but slower. The language is detected automatically.

It also adds [LiteRT](https://pypi.org/project/ai-edge-litert/) to run Google's
[YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet) sound classifier (Apache-2.0) for laughter,
cheering and screaming. It runs on your machine too; the first analysis downloads the model once
(about 4 MB, checked against a fixed SHA-256) into `media/models`. Turn it off with
`SOUND_EVENTS_ENABLED=false`. Without it, analysis still works on loudness and scene changes.

For very large files, copy them into the media folder shown in the panel and register them through the API (`POST /api/v1/media/register`).

## Live tab audio

With a Twitch or Kick channel open in a tab, click the StreamHunter icon and choose
**Measure this tab's audio**. StreamHunter then measures the stream's loudness once per second, and
new live highlights get a measured audio signal ("Stream audio 12 dB louder than usual") next to chat.

* Only one loudness number per second is sent to your backend. The audio itself is never recorded,
  stored or sent anywhere, and the tab stays audible.
* Chrome only allows capturing a tab after you click the extension on it, so this is started by
  hand each time. Chrome shows its "sharing audio" indicator on the tab while it runs.
* It stops when you click **Stop measuring**, close the tab, or close Chrome.
* The channel must be on your watchlist, live and monitored; otherwise the popup says **Not monitored**
  and nothing is kept.
* After about 30 seconds StreamHunter knows the stream's normal level. Muting the player on the
  page also silences the measurement.

**Live laughter and cheering (opt-in).** Before clicking **Measure this tab's audio**, tick
**Also detect laughter and cheering**. The popup then shows what it hears ("Hearing laughter 90%"),
and a live highlight with clear laughter becomes a *funny moment* ("Laughter in the audio (90% match)").
This needs the media extras on the backend. Unlike loudness, it sends the tab's audio itself
(16 kHz mono, about 32 KB per second) to **your own** StreamHunter backend, which classifies it in
memory and keeps only the laughter/cheering/screaming numbers; the audio is never stored.

## Known limitations

* Monitoring runs **only while Chrome is open**. Closing the browser pauses it.
* Kick has **no official clip or VOD API**. Kick clips need a manual step.
* A Twitch clip is a link on Twitch, not a downloadable video file.
* Stream offsets are approximate (they come from the platform's `started_at`).
* Tab audio follows what you see, a few seconds behind the broadcast (like chat). Without the
  laughter option, live audio is loudness only, which can't tell laughter from shouting.
* On-screen detection is generic: it doesn't know the game, so it can't tell a kill or a win from a
  busy menu animation. Recognising specific game events would need a model per game.
* Laughter detection hears a stream's sound as a whole: a laugh track, a game's crowd or music with
  cheering can count too. It names a moment only when it is fairly sure (45% or more).
  It hears a laugh best when it's the main sound (the streamer laughing instead of talking); a laugh
  quieter than game dialogue or other voices playing at the same time is often missed.

## Documentation

* [PROJECT_PLAN.md](PROJECT_PLAN.md): phases, risks, decisions
* [ARCHITECTURE.md](ARCHITECTURE.md): system design and verified platform capabilities
* [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): what works, what is pending
* [API_DOCUMENTATION.md](API_DOCUMENTATION.md): endpoints, errors, conventions (live docs at `/docs`)
* [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md): tables, constraints, migrations
* [SECURITY.md](SECURITY.md): security and privacy policy
