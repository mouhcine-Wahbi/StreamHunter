# Data storage

Everything is stored in the browser profile where the extension is installed. Nothing is synced or
uploaded.

## IndexedDB `streamhunter` (version 1) — `extension/src/local/db.ts`

| Store | Key | Indexes | Contents |
|---|---|---|---|
| `streamers` | `id` (auto) | `platformUser` = [platform, platform_user_id] (unique) | Monitoring list: platform, ids, username, display name, avatar, live state, title, category, viewers, `viewer_history` (this broadcast, ≤ 8), last check, monitoring on/off, favourite |
| `sessions` | `id` (auto) | `streamer` | One per broadcast: status `active` / `paused` / `ended`, broadcast start, started/ended, last check, last event |
| `highlights` | `id` (auto) | `streamer` | Moment: streamer, session, `origin` (chat / viewers / capture), time, offsets into the stream, `window_start_ms` / `window_end_ms`, score, confidence, category, reasons, signal breakdown, review status |
| `clips` | `id` (auto) | `candidate` (highlight id) | Clip metadata: title, duration, size, MIME type, resolution, first-frame time, score |
| `clipBlobs` | clip id | | The MP4 file (Blob) |

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
| `sh.capture` | Capture state (status, tab, channel, buffered seconds, clips saved, message) |
