# StreamHunter

**Find the moment. Create the clip.**

StreamHunter is a Chrome extension for video editors and clipping teams. It watches
Twitch and Kick streamers while your browser is open, reads chat to spot moments
when the audience reacts, explains *why* each moment was flagged, and helps you turn
it into a clip. Nothing is ever published without your approval.

> **Status:** Phase 3 is code-complete. Twitch and Kick lookup, live status and account connections
> are built and tested against mocked platform APIs. Confirming them against the live APIs needs your
> developer credentials. Browser monitoring (Phase 4) comes next.
> See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

![Overview](docs/screenshots/app-overview.png)

## Features

| | Status |
|---|---|
| MV3 extension: popup, full-page workspace, side panel | ✅ |
| Settings (monitoring interval, sensitivity, score threshold, languages, clip defaults, notifications, time zone, retention) | ✅ |
| Browser-based monitoring control with heartbeat, backoff and restart recovery | ✅ (extension side) |
| Backend: accounts (Argon2, revocable sessions), watchlist API, settings API, capability reporting | ✅ |
| Twitch search, Kick exact-name lookup, live status, title & category | ✅ (needs credentials) |
| Connect Twitch / Kick accounts (OAuth; PKCE for Kick; tokens encrypted) | ✅ (needs credentials) |
| Chat-based highlight detection with explainable scores | ⏳ Phase 5 |
| Twitch clip creation; Kick manual workflow | ⏳ Phase 6 |

## Technology

* **Extension:** Chrome Manifest V3, React 19, TypeScript (strict), Vite 7, Tailwind CSS 4, Lucide icons
* **Backend:** Python 3.12+, FastAPI, Pydantic, SQLAlchemy 2, Alembic, SQLite → PostgreSQL, HTTPX, Pytest

## Requirements

* Node.js 20+ and npm 10+
* Google Chrome 116+ (or another Chromium browser)
* Python 3.12+ (backend)

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

## Known limitations

* Monitoring runs **only while Chrome is open**. Closing the browser pauses it.
* Kick has **no official clip or VOD API**. Kick clips need a manual step.
* A Twitch clip is a link on Twitch, not a downloadable video file.
* Stream offsets are approximate (they come from the platform's `started_at`).

## Documentation

* [PROJECT_PLAN.md](PROJECT_PLAN.md): phases, risks, decisions
* [ARCHITECTURE.md](ARCHITECTURE.md): system design and verified platform capabilities
* [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): what works, what is pending
* [API_DOCUMENTATION.md](API_DOCUMENTATION.md): endpoints, errors, conventions (live docs at `/docs`)
* [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md): tables, constraints, migrations
* [SECURITY.md](SECURITY.md): security and privacy policy
