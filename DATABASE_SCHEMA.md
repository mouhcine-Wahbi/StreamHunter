# Data storage

Everything is stored in the browser profile where the extension is installed. Nothing is synced or
uploaded.

## IndexedDB `streamhunter` (version 2) — `extension/src/local/db.ts`

| Store | Key | Indexes | Contents |
|---|---|---|---|
| `streamers` | `id` (auto) | `platformUser` = [platform, platform_user_id] (unique) | Monitoring list: platform, ids, username, display name, avatar, live state, title, category, viewers, `viewer_history` (this broadcast, ≤ 8), last check, monitoring on/off, favourite, `auto_record` |
| `sessions` | `id` (auto) | `streamer` | One per broadcast: status `active` / `paused` / `ended`, broadcast start, started/ended, last check, last event |
| `highlights` | `id` (auto) | `streamer` | Moment: streamer, session, `origin` (chat / viewers / capture), time, offsets into the stream, `window_start_ms` / `window_end_ms`, score, confidence, category, reasons, signal breakdown, review status |
| `clips` | `id` (auto) | `candidate` (highlight id) | Clip metadata: title, streamer, platform, stream `category`, `reasons`, `detection_types` (audio/chat/visual/viewers/manual), score, `peak_at`, `stream_offset_sec`, duration, size, MIME type, resolution, first-frame time, `favorite`, `has_thumbnail`, optional Twitch clip id/url |
| `clipBlobs` | clip id | | The MP4 file (Blob) |
| `clipThumbs` | clip id | | JPEG thumbnail (320 px wide) from the moment's peak (added in v2) |

Chat messages are never stored: they are analysed in memory and discarded. Retention (Settings →
Privacy) deletes highlights without a clip and ended sessions older than N days.

## chrome.storage.local

| Key | Contents |
|---|---|
| `sh.settings` | Settings (validated by `sanitizeSettings`) |
| `sh.monitoring` | Monitoring state shown in the UI (status, last check, live count, backoff) |
| `sh.platformCredentials` | The editor's Twitch / Kick app client IDs and secrets |
| `sh.appTokens` | Cached app access tokens with expiry |
| `sh.twitchUser` | Sign in with Twitch: user token, user id, login, scopes, expiry |
| `sh.chatActivity` | Per-streamer chat state and aggregates for the Live Monitoring page |
| `sh.capture` | Capture state: status, mode (`manual` / `recorder`), recording, paused, waiting reason, tab, channel, buffered seconds, silent seconds, recorded seconds, last detection, clips saved, message |
| `sh.stats` | Lifetime totals: `recordedSeconds` |
