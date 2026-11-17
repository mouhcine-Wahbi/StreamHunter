# API

StreamHunter has no server API. This page documents (1) the **internal local API** the extension
pages use, which `LocalApi` (`extension/src/local/local-api.ts`) answers inside the browser, and
(2) the **platform endpoints** StreamHunter calls.

## 1. Internal local API

Paths look like HTTP routes so the pages stay simple, but nothing goes over the network: each call
reads or writes IndexedDB, or calls Twitch/Kick. Errors are `ApiError`s with an HTTP-like status and a
`code` (`platform_not_configured` 503, `already_in_watchlist` 409, `streamer_not_found` 404,
`not_found` 404, `platform_rate_limited` 429, `platform_http` / `platform_unauthorized` 502).

Lists return `{items, total, limit, offset}` and accept `limit` / `offset`.

### Streamers and discovery
| | |
|---|---|
| `GET /api/v1/streamers/search?platform=twitch\|kick&username=` | Twitch: Search Channels (exact match first, viewer counts for live ones). Kick: exact channel lookup |
| `GET /api/v1/discover/live?platform=&limit=` | Live channels, most viewers first |
| `GET /api/v1/streamers` · `POST /api/v1/streamers {platform, username}` | Monitoring list / add (resolved on the platform; 409 `already_in_watchlist`) |
| `PATCH /api/v1/streamers/{id} {monitoring_enabled?, is_favorite?}` · `DELETE /api/v1/streamers/{id}` | Update / remove |
| `GET /api/v1/streams/live` | Live streamers on the list |
| `POST /api/v1/streams/refresh` | Check live status now → `{checked, live, skipped_recent, unavailable: {platform: reason}}` |
| `GET /api/v1/platforms/capabilities` | Per platform: `configured` (app credentials saved) and what is supported |

### Monitoring
| | |
|---|---|
| `GET /api/v1/monitoring` | Sessions (one per broadcast), newest first |
| `GET /api/v1/monitoring/{id}/activity` | Chat state (`connected` / `connecting` / `unavailable` + reason / `not_monitored`) and aggregates: messages and chatters per minute, normal rate, warming up, 3-minute series, active signals. No message content |

### Highlights and clips
| | |
|---|---|
| `GET /api/v1/highlights?platform&status&min_score&date_from&streamer_id&has_video&sort=score` | Highlights; `sort=score` ranks them. Each has `origin` (`chat` / `viewers` / `capture`), `has_video`, `clip`, `reasons`, `signal_breakdown`, `window_start_ms` / `window_end_ms` |
| `GET /api/v1/highlights/{id}` · `POST …/approve` · `POST …/reject` · `PATCH {status: "pending_review"}` · `DELETE` | Review |
| `GET /api/v1/clips?sort=score` | Clips (MP4s from captures): duration, size, resolution, score, `started_at` |
| `PATCH /api/v1/clips/{id} {title}` · `DELETE /api/v1/clips/{id}` | Rename / delete (also deletes the video) |

The video itself is read from the `clipBlobs` store (`clipBlob(id)` in `src/local/clips.ts`).

### Worker messages
Pages talk to the service worker with `chrome.runtime.sendMessage` (`src/types/messages.ts`):
`monitoring/get|start|stop|check-now`, `app/open`, `capture/get|start {tabId, url}|stop|save-last {seconds}`.
The offscreen engine reports `capture/status`, `capture/clip-saved`, `capture/clip-failed`, `capture/ended`.

## 2. Platform endpoints used

| Platform | Endpoint | Auth | Used for |
|---|---|---|---|
| Twitch | `POST https://id.twitch.tv/oauth2/token` (client_credentials) | client id + secret | App token |
| Twitch | `GET /helix/search/channels?query=&first=20` | app token | Search |
| Twitch | `GET /helix/streams?user_id=…(≤100)&first=100` · `GET /helix/streams?first=` | app token | Live status, live now |
| Twitch | `GET /helix/users?id=…(≤100)` | app token | Avatars |
| Twitch | `https://id.twitch.tv/oauth2/authorize` (implicit, `user:read:chat`) · `GET /oauth2/validate` · `POST /oauth2/revoke` | user | Sign in with Twitch |
| Twitch | `wss://eventsub.wss.twitch.tv/ws` + `POST/DELETE /helix/eventsub/subscriptions` (`channel.chat.message` v1) | user token | Chat |
| Kick | `POST https://id.kick.com/oauth/token` (client_credentials) | client id + secret | App token |
| Kick | `GET https://api.kick.com/public/v1/channels?slug=…(≤50)` | app token | Lookup, live status |
| Kick | `GET /public/v1/users?id=…` · `GET /public/v1/livestreams?limit=&sort=viewer_count` | app token | Avatars, live now |

Kick's per-field response shapes come from its OpenAPI spec and are parsed defensively (unknown
fields ignored, ids as numbers or strings, Go zero times treated as "never").
