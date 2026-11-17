# Architecture

StreamHunter is a single Chrome extension (Manifest V3, React 19, TypeScript, Vite, Tailwind). There
is no server. Until v1.0 a FastAPI backend existed; it was retired in the local-first migration
([docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md)) and is in git history before that.

## 1. Pieces

```text
┌───────────────────────────── Chrome extension ─────────────────────────────┐
│ Pages (popup, workspace, side panel)                                       │
│   └─ useApiQuery / useApiClient → LocalApi ("/api/v1/..." paths, in-page)   │
│                                                                            │
│ Service worker (alarms, messages, notifications)                           │
│   ├─ monitoring-manager: alarm → status check → sessions → notifications   │
│   ├─ chat-manager: Twitch EventSub WebSocket → StreamAnalyzer → highlights │
│   └─ capture-manager: start/stop capture, forward clip requests            │
│                                                                            │
│ Offscreen document (needed for tab media)                                  │
│   └─ capture engine: tab video/audio → WebCodecs → rolling buffer → MP4    │
│                                                                            │
│ Storage: IndexedDB "streamhunter" (data, clip videos)                      │
│          chrome.storage.local (settings, credentials, tokens, live state)  │
└────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS (host permissions)                 │ WSS
        ▼                                          ▼
  api.twitch.tv / id.twitch.tv               eventsub.wss.twitch.tv
  api.kick.com  / id.kick.com
```

* **LocalApi** (`src/local/local-api.ts`) keeps the `/api/v1/...` paths and response shapes the pages
  were built on, but answers them from IndexedDB and the platform clients. Unknown paths are a local 404.
* **Platform clients** (`src/platforms/`): `createTwitchClient` (Helix: Search Channels, Get Streams,
  Get Users) and `createKickClient` (public API: channels by slug, users, livestreams). Both use an app
  access token from the editor's own app (client credentials), cached in storage, refreshed once on 401.
  Status checks are batched: 100 Twitch ids or 50 Kick slugs per request. A 429 records the wait the
  platform asked for (Retry-After / Ratelimit-Reset).

## 2. Discovery mode (background)

```text
chrome.alarms (every N min, default 2)
  → refreshStatuses(): one request per platform per 100/50 streamers
      → streamers updated (live, title, category, viewers, viewer history)
      → went live / went offline, viewer spikes (≥ 1.5× and +100 over this broadcast's median)
  → syncSessions(): open a session per live monitored streamer, end it when offline
  → notifications (go-live opt-in), viewer-spike highlights (provisional)
  → chat-manager.sync()
```

**Chat (Twitch).** With "Sign in with Twitch" (`chrome.identity.launchWebAuthFlow`, implicit grant,
scope `user:read:chat`), the worker opens one EventSub WebSocket (`keepalive_timeout_seconds=10`;
Chrome 116+ keeps a worker alive while a WebSocket is active) and subscribes to
`channel.chat.message` for every live Twitch streamer in an active session. Messages go into a
per-stream `StreamAnalyzer`, which is evaluated every 5 s:

```text
messages → RollingChatWindow (5 s buckets, ≤ 2 counted messages per chatter per bucket,
           bots/commands/broadcaster ignored, 5-minute baseline per stream)
         → detectors: chat spike (z-score + ratio vs baseline), emote wave, repeated phrase,
           clip requests, reactions (8 language packs + custom phrases), mood shift
         → moments (open on first event, close after 10 s quiet or 90 s; 20 s cooldown)
         → score (renormalized weights: only signals that exist count), category from evidence
         → sensitivity filter (low / medium / high) → highlight (provisional) → notification
```

Kick's official API delivers chat only via webhooks to a public HTTPS server, so Kick sessions report
chat as unavailable and rely on live status and viewer spikes.

## 3. Capture mode

The editor clicks **Capture this stream** in the popup on a stream tab. That click lets
`chrome.tabCapture.getMediaStreamId` work; the worker creates the offscreen document (reason
`USER_MEDIA`) and starts the engine there:

```text
getUserMedia(tab video ≤ 1280×720 ≤ 30 fps + tab audio)
  ├─ audio → AudioContext → speakers (capturing would otherwise mute the tab)
  ├─ video → MediaStreamTrackProcessor → VideoEncoder (H.264, keyframe every 2 s, 3 Mbit/s)
  │          + every 250 ms a 64×36 sample → motion (mean |Δluma|) and brightness
  ├─ audio → MediaStreamTrackProcessor → AudioEncoder (AAC 128 kbit/s, Opus fallback)
  │          + RMS loudness per second
  └─ ChunkRing: encoded chunks of the last 120 s (wall-clock timestamps)

every second: LiveSignals (2-minute rolling median per stream)
  → loud (≥ 6 dB over normal for 2 s), fast action (≥ 2.5× usual motion for 2 s),
    flash (brightness +50 and back)
  → score = calculateScore({audio, visual}); ≥ minimum score → highlight (origin "capture")
clip requests (capture moments, chat/viewer highlights of the captured streamer, Save last N s)
  → wait for the post-roll → ChunkRing.select(from keyframe ≤ start … end)
  → mp4-muxer (no re-encode, tracks aligned) → IndexedDB clips + clipBlobs → notification
```

A clip covers `[moment − pre-roll, moment + post-roll]` (Settings → Clips, default 20 s / 10 s), within
what the buffer still holds.

## 4. Data

See [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md). Retention (Settings → Privacy, default 30 days) deletes
provisional highlights and ended sessions after each status check; highlights with a clip stay until
the clip is deleted.

## 5. Chrome constraints and how they are handled

| Constraint | Handling |
|---|---|
| The service worker can stop at any time | All state in storage; alarms drive checks; single-flight ticks; restore on startup |
| Alarms fire at most every 30 s | Interval in minutes (1–60) |
| Tab media needs a document | Offscreen document (one per extension) hosts the capture engine |
| Tab capture needs a user gesture on that tab | Capture starts only from the popup; detections notify with Open stream |
| A WebSocket keeps the worker alive only while active | Twitch keepalive every 10 s; the socket closes when no Twitch session is active |
| Storage quota | Clips are ~0.4 MB/s at 720p; delete from the Clip Library |
