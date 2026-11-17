# StreamHunter — Project Plan

## Goal

A search-first, local-first Chrome extension (MV3) that lets an editor discover Twitch and Kick
streamers, monitor many channels in the background, detect potential viral moments, capture
selected streams and manage ranked, downloadable clips — with no server. (Until v1.0 a FastAPI
backend did the monitoring and processing; see docs/LOCAL_FIRST_MIGRATION.md.)

## Repository layout

```text
streamhunter/
├── extension/            Chrome extension (React + TS + Vite + Tailwind)
│   ├── public/manifest.json, icons/
│   ├── popup.html, app.html, sidepanel.html
│   └── src/{background,popup,sidepanel,pages,components,hooks,services,store,types,utils,styles}
│       src/local      IndexedDB store + LocalApi        src/platforms  Twitch/Kick clients
│       src/detection  chat analyzer                     src/capture    capture engine, buffer, MP4
├── docs/LOCAL_FIRST_MIGRATION.md
├── PROJECT_PLAN.md  ARCHITECTURE.md  IMPLEMENTATION_STATUS.md
└── README.md  API_DOCUMENTATION.md  DATABASE_SCHEMA.md  SECURITY.md
```

## Phases

Phases 0–7 built the backend-era product (see IMPLEMENTATION_STATUS.md, "History"). v1.0 is the
local-first migration (docs/LOCAL_FIRST_MIGRATION.md, steps 1–7): local store and platform clients,
search-first Discover, background monitoring, discovery-mode detection, capture mode, local
highlights/clips, backend removal.

## Technical risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Kick chat only via webhooks to a public HTTPS URL | No Kick chat without a server | Kick uses live status and viewer spikes; chat shown as unavailable with the reason |
| Tab capture needs a user gesture | Capture can't start by itself | Notifications with Open stream; capture from the popup on the tab |
| MV3 worker suspension | Missed checks, dropped chat socket | Alarms + storage-backed state; EventSub keepalive every 10 s keeps the worker alive; re-sync after every check |
| API rate limits | Throttling | Batched requests (100 Twitch / 50 Kick), interval ≥ 1 min, Retry-After / Ratelimit-Reset honoured |
| Storage quota for clips | Clips fail to save | ~0.4 MB/s at 720p, 2-minute buffer in memory only, delete from the Clip Library |
| Platform field names drift | Wrong or missing data | Defensive parsing; fakes follow the documented shapes; verify with real credentials |

## Decisions needing the owner

* **Developer applications**: each editor creates free Twitch and Kick apps and enters the client
  ID and secret in Settings. No credentials have been invented.
* No paid services are needed.
