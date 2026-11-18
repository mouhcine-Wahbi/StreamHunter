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
| `GET /api/v1/streamers` (with `clip_count`) · `POST /api/v1/streamers {platform, username}` | Monitoring list / add; `username` may be a name, link, @handle or channel ID (resolved by the adapter; 409 `already_in_watchlist`) |
| `PATCH /api/v1/streamers/{id} {monitoring_enabled?, is_favorite?, auto_record?, priority?}` · `DELETE /api/v1/streamers/{id}` | Update / remove |
| `GET /api/v1/streams/live` | Live streamers on the list |
| `POST /api/v1/streams/refresh` | Check live status now → `{checked, live, skipped_recent, unavailable: {platform: reason}}` |
| `GET /api/v1/platforms/capabilities` | Per platform: `configured`, `auth_message`, and per feature `{support: supported/partial/unsupported, verified: verified/simulated/untested, note}` |

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
| `GET /api/v1/clips?sort=score|oldest&since=&platform&streamer_id&category&duration=short\|medium\|long&type=audio\|chat\|visual\|viewers\|manual&favorite=true&min_score` | Clips with their metadata; default newest first |
| `GET /api/v1/highlights?clip_status=generating,failed` | Clips being generated or failed (with `clip_error`); never in the clip lists |
| `GET /api/v1/clips/stats` | Clip count, favourites, total bytes and seconds, recorded seconds, browser storage estimate |
| `PATCH /api/v1/clips/{id} {title?, favorite?}` · `DELETE /api/v1/clips/{id}` | Rename / favourite / delete (also deletes the video and thumbnail) |

The video itself is read from the `clipBlobs` store (`clipBlob(id)` in `src/local/clips.ts`).

### Worker messages
Pages talk to the service worker with `chrome.runtime.sendMessage` (`src/types/messages.ts`):
`monitoring/get|start|stop|pause|resume|check-now`, `app/open`,
`capture/get {tabId?}|list|start {tabId, url}|arm {tabId}|sync|stop {tabId?}|pause-slot {tabId, paused}|listen {tabId, on}|save-last {seconds, tabId?}`, `system/get`.
The worker sends the offscreen engines `capture/start|target|signal|pause|listen|throttle|options|clip|stop`,
each with `slot` (the captured tab id; `capture/stop` without one stops all); the engines report
`capture/status` (with `health`), `capture/detection`, `capture/clip-saved`, `capture/clip-failed`, `capture/ended`, each with `slot`.

## 2. Platform endpoints used

| Platform | Endpoint | Auth | Used for |
|---|---|---|---|
| Twitch | `POST https://id.twitch.tv/oauth2/token` (client_credentials) | client id + secret | App token |
| Twitch | `GET /helix/search/channels?query=&first=20` | app token | Search |
| Twitch | `GET /helix/streams?user_id=…(≤100)&first=100` · `GET /helix/streams?first=` | app token | Live status, live now |
| Twitch | `GET /helix/users?id=…(≤100)` | app token | Avatars |
| Twitch | `https://id.twitch.tv/oauth2/authorize` (implicit, `user:read:chat`) · `GET /oauth2/validate` · `POST /oauth2/revoke` | user | Sign in with Twitch |
| Twitch | `wss://eventsub.wss.twitch.tv/ws` + `POST/DELETE /helix/eventsub/subscriptions` (`channel.chat.message` v1) | user token | Chat |
| Twitch | `POST /helix/clips?broadcaster_id=` | user token with `clips:edit` | Optional native Twitch clip (off by default) |
| Kick | `POST https://id.kick.com/oauth/token` (client_credentials) | client id + secret | App token |
| Kick | `GET https://api.kick.com/public/v1/channels?slug=…(≤50)` | app token | Lookup, live status |
| Kick | `GET /public/v1/users?id=…` · `GET /public/v1/livestreams?limit=&sort=viewer_count` | app token | Avatars, live now |

| YouTube | `GET https://www.youtube.com/feeds/videos.xml?channel_id=` | none (public feed) | Newest video IDs per channel (live check, no quota) |
| YouTube | `GET /youtube/v3/videos?part=snippet,liveStreamingDetails&id=…(≤50)` | API key, 1 unit | Which are live: title, category id, concurrentViewers, actualStartTime/EndTime |
| YouTube | `GET /youtube/v3/channels?part=snippet&id=…` · `&forHandle=@…` | API key, 1 unit | Resolve a channel (name, handle, avatar) |
| YouTube | `GET /youtube/v3/playlistItems?part=contentDetails&playlistId=UU…` | API key, 1 unit | Fallback when the feed can't be read |
| YouTube | `GET /youtube/v3/videoCategories?part=snippet&id=` | API key, 1 unit | Category names (cached) |
| YouTube | `GET /youtube/v3/search?part=snippet&type=channel&q=` · `&type=video&eventType=live&order=viewCount` | API key, **100 units** | Search, live now: only when the editor clicks |

Twitch Helix calls use the app token, or the Sign in with Twitch user token when no secret is saved.
YouTube errors are read from the documented `error.errors[0].reason` (`quotaExceeded`, `keyInvalid`,
`accessNotConfigured`); the key is never logged or echoed.

Kick's per-field response shapes come from its OpenAPI spec and are parsed defensively (unknown
fields ignored, ids as numbers or strings, Go zero times treated as "never").
