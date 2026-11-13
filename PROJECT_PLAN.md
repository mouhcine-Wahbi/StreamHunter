# StreamHunter — Project Plan

## Goal

A Chrome extension (MV3) and a FastAPI backend that watch Twitch and Kick streamers
while the browser is open, detect highlight moments from chat activity, explain
why each moment was picked, and help an editor turn it into a clip. The editor
reviews everything, and nothing is ever published automatically.

## Repository layout

```text
streamhunter/
├── extension/            Chrome extension (React + TS + Vite + Tailwind)
│   ├── public/manifest.json, icons/
│   ├── popup.html, app.html, sidepanel.html
│   └── src/{background,popup,sidepanel,pages,components,hooks,services,store,types,utils,styles}
├── backend/              FastAPI service (Phase 2+)
│   ├── app/{api,models,schemas,services,integrations,monitoring,detection,clipping,workers,utils}
│   ├── migrations/       Alembic
│   └── tests/
├── PROJECT_PLAN.md  ARCHITECTURE.md  IMPLEMENTATION_STATUS.md
└── README.md  API_DOCUMENTATION.md  DATABASE_SCHEMA.md  SECURITY.md  .env.example
```

## Phases

| # | Phase | Key deliverables | Exit criteria |
|---|---|---|---|
| 0 | Inspection & planning | Plan, architecture, platform research | Docs written, limitations identified |
| 1 | Extension foundation | MV3 manifest, popup, full page, side panel, navigation, dark theme, settings persistence, service worker with alarms, API client, tests | `npm run build` loads in Chrome without errors; settings persist; tests pass |
| 2 | Backend foundation | FastAPI, SQLAlchemy models, Alembic, SQLite, auth (register/login, hashed passwords, bearer sessions), streamer CRUD, adapter interfaces, tests | Server starts, migrations run, `/docs` works, streamers persist |
| 3 | Twitch + Kick integration | OAuth (backend exchange, PKCE for Kick), search, lookup, live status, category/title, capability endpoint | Real results when credentials configured; explicit `requires_configuration` otherwise |
| 4 | Browser monitoring | Heartbeat lease, scheduled status polling, live/offline transitions, sessions, recovery | Monitoring stops when the lease expires and resumes after Chrome restarts |
| 5 | Chat intelligence | Twitch EventSub chat collector, Kick webhook receiver, rolling windows, detectors, scoring, candidates | Simulated chat produces explained candidates in tests |
| 6 | Clip workflow | State machine, Twitch Create Clip, Kick manual action, review UI, retry | Supported clips are created; unsupported ones are never faked |
| 7 | VOD & advanced AI | VOD discovery, authorized media sources, merging, audio/video modules | Optional; does not block the MVP |

## Technical risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Kick chat only via webhooks to a public HTTPS URL | Kick chat monitoring cannot work on plain localhost | Backend webhook receiver + documented tunnel setup; capability reports `requires_configuration` until set up |
| Kick has no clip or VOD API | No automatic Kick clips | `requires_manual_action`: open the channel at the right moment, and the editor records the clip URL by hand |
| Twitch clip ≠ downloadable file | Export pipeline cannot assume media | Separate `platform_clip_url` from `local_file_path`; export only from authorized sources |
| MV3 worker suspension | Missed polls | Alarms + storage-backed state + backend lease; honest status |
| Platform docs not reachable from dev container | Field names may drift | Adapters parse defensively with Pydantic and are covered by mocked tests; integration tests run only with real credentials |
| Browser clock vs. stream position | Wrong clip offsets | Offsets only from platform `started_at`, labelled approximate |
| API rate limits | Throttling | Configurable intervals (min 1 min), batched Helix requests (up to 100 IDs), respect `Ratelimit-*` headers, backoff |

## Decisions needing the owner (not made unilaterally)

* **Developer applications**: Twitch and Kick client IDs/secrets must be created by
  the owner (free). No credentials have been invented.
* **Public URL for Kick webhooks**: a tunnel or a deployed backend is needed. A free
  Cloudflare Tunnel is enough for development.
* No paid services are needed for the MVP.
