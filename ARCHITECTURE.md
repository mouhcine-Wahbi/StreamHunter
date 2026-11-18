# Architecture

StreamHunter is a single Chrome extension (Manifest V3, React 19, TypeScript, Vite, Tailwind). There
is no server. Until v1.0 a FastAPI backend existed; it was retired in the local-first migration
([docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md)) and is in git history before that.

## 0. What changed in 2.0

* **Platform adapters** (`src/platforms/adapter.ts`, `registry.ts`, `youtube.ts`): Twitch, Kick and
  YouTube behind one interface: `search`, `resolve` (name/link/handle/ID), `status` (live state +
  stream metadata, batched), `discoverLive`, `capabilities()` (support + how it was verified),
  `authStatus()`, `watchUrl`, `parseUrl`. Monitoring, the scheduler and the pages only use this
  interface. Adding/removing a channel is local (IndexedDB); the adapter resolves it.
* **YouTube** uses the Data API v3 with the editor's own API key (public data, so no OAuth). For
  live checks it reads each channel's public upload feed (no quota), then makes one `videos.list` per
  50 IDs (1 unit); it falls back to `playlistItems.list` (1 unit). Search and live-now use
  `search.list` (100 units), only on request. A daily budget (8,000 of 10,000 units, reset at
  midnight Pacific) stops calls before the key is exhausted.
* **Scheduler** (`src/background/scheduler.ts`, pure): explainable priority and slot decisions; see §3.
* **Clip lifecycle**: generating → ready / failed (with the reason). Interrupted clips are marked
  failed at startup.
* **Twitch without a secret**: Helix calls use the Sign in with Twitch user token.

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

## 3. Recording and automatic clipping

### Scheduler (v2.0)

After every live check (and on arm, settings changes and failures) `runSync` → `plan()`:

```text
priority(streamer) = Σ weight × part / Σ weights            (default 45 / 20 / 15 / 15 / 5)
  potential   clips per recorded hour ×20 (capped) ·0.6 + average clip score ·0.4; 50 until 10 min recorded
  activity    0 / 40 / 70 / 100 for 0 / 1 / 2 / 3+ moments in the last 30 min
  growth      viewer growth over this broadcast's median (+50% = 100) ·0.7 + log10(viewers)/5 ·0.3
  user        50 + 20 × priority(−2…+2) + 30 if favourite
  reliability 100 − 30 × recent failures
eligible = live ∧ monitored ∧ Auto-record ∧ not waiting to retry ∧ not given up ∧ not in a manual capture
1. keep slots whose streamer is still eligible (paused slots keep theirs)
2. free/released slots take the highest-priority eligible streamers
3. at most one switch per run: best waiting vs weakest recording, only if
   gap ≥ switchMargin (12) ∧ recorded ≥ minRecordMinutes (10) ∧ since last switch ≥ cooldown (5)
   ∧ no clip of it pending
4. everyone live but not recorded → queue with a reason (waiting for slot, retry wait, gave up,
   Auto-record off, manual capture)
```

Failures: a slot whose player shows no picture for 45 s or a black picture for 60 s fails its
streamer. The slot is released and the streamer retried after 2, 5 and 15 minutes (`maxRetries`, 3),
then not again for that broadcast; a new broadcast resets it. A 10-minute healthy recording clears
failures. Every run is saved to `sh.scheduler` for the dashboard. Each slot's decision is applied in
isolation: an error stops that slot's encoding and is shown, never a silent "not recording" while
encoding.

### Several streams at once (v1.2)

Each recorder tab is a **slot**: the offscreen document (one per extension) runs one engine per slot,
each with its own buffer, signals, fusion and clips; messages carry `slot` (the tab id). Verified in
Chrome 157: 5 tabs captured at once by one extension, 30 fps each, also in background tabs and a
minimized window; a tab can't be captured twice. The worker keeps all slots in `sh.captures` (one
store, writes serialised because every engine reports every 3 s) and assigns streamers:

```text
assignTargets(): live + monitored + Auto-record streamers, favourites then viewers
  → a slot keeps its streamer while it is live (sticky), never two slots for one streamer,
    streamers in a manual capture are skipped, free slots take the rest; extra slots wait
limit (Settings → Recording, default 1): arming beyond it is refused; lowering it stops the newest
per slot: Pause/Resume (reason: you / monitoring / overload / storage), Stop, Listen (one at a time)
chat/viewer signals → the slot recording that streamer
```

**Overload protection** (`resource-governor.ts`, every ~10 s while recording): whole-machine CPU
(`chrome.system.cpu`), available memory (`chrome.system.memory`), browser storage, and each slot's
dropped frames. Sustained ~30 s over the limits (CPU ≥ 90%, < 1 GB free memory, > 10 frames dropped
per 3 s) → new slots refused, the lowest-priority stream records at half frame rate, then pauses (the
last running stream is never paused for load). A minute of normal load undoes one step at a time.
Disk almost full (< 2 GB) → cleanup, then every stream pauses until space is back. A low frame rate
alone is not overload: Chrome only produces frames when a page changes.

### One stream

Chrome lets an extension capture a tab only after the user invokes it on that tab. Verified in
Chrome 157: once running, a tab capture **continues when the tab navigates** (same site or
another). So the editor arms one **recorder tab** once (popup → *Use this tab as the recorder*), and
the worker (`capture-manager.ts`) then directs it after every status check:

```text
pickRecordingTarget(): live + monitored + Auto-record; keep the current one while live,
                       else favourites first, then most viewers
  → different streamer: chrome.tabs.update(recorder, streamUrl) + engine.setTarget(streamer)
      (pending clips of the previous streamer are cut first, then the buffer is cleared)
  → same streamer, new session (stream restarted): reload the page, keep recording
  → nobody live / monitoring stopped / paused: engine idle (frames dropped, nothing encoded)
```

Manual capture (*Only capture this stream*) uses the same engine with a fixed target. The worker
creates the offscreen document (reason `USER_MEDIA`) and starts the engine there:

```text
getUserMedia(tab video ≤ 1280×720 ≤ 30 fps + tab audio)
  ├─ audio → AudioContext → speakers (capturing would otherwise mute the tab)
  ├─ video → MediaStreamTrackProcessor → VideoEncoder (H.264, keyframe every 2 s, 3 Mbit/s)
  │          + every 250 ms a 64×36 sample → motion (mean |Δluma|) and brightness
  ├─ audio → MediaStreamTrackProcessor → AudioEncoder (AAC 128 kbit/s, Opus fallback)
  │          + RMS loudness per second
  └─ ChunkRing: encoded chunks of the last 120 s (wall-clock timestamps)

every second: LiveSignals (2-minute rolling median per stream) → fusion signals
  audio:  ≥ 6 dB over normal for 2 s; +12 dB jump (burst); loud + high zero-crossing rate
          (shouting-like; sustained and even → cheer-like); envelope pulsing at 3–7 Hz (laughter-like)
  visual: ≥ 2.5× usual motion for 2 s; scene cuts more often than usual; flash
worker → engine: chat moments and viewer spikes of the recorded streamer (as signals)
AutoClipper (capture/autoclip.ts)
  FusionEngine: signals within 10 s of each other = one moment (≤ 60 s)
    score = Σ weight × intensity/100 (+ bonus for ≥ 2 kinds); ≥ threshold → clip
  ClipPlanner: [start − pre-roll, end + post-roll]; overlap with a pending clip → extend (≤ max);
    peak inside a saved clip → merge reasons; pre-roll overlapping a saved clip → start after it
  → highlight (origin "capture", fused); chat/viewer highlights it absorbed are deleted
  → after the post-roll: ChunkRing.select → mp4-muxer → clips + clipBlobs + clipThumbs (JPEG)
  → storage limits enforced → optional Twitch clip → notification
```

Defaults: weights audio 25, chat 30, visual 20, viewers 15, multi 10; threshold 40; 20 s before
and after; buffer 120 s (always ≥ pre + post + 70 s so a moment's footage is still there when its
post-roll ends); clips ≤ 90 s. All configurable in Settings.

## 4. Data

See [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md). Retention (Settings → Privacy, default 30 days) deletes
provisional highlights and ended sessions after each status check. Settings → Storage limits the
clips (default 5 GB, optional maximum age): the oldest non-favourite clips are deleted after each
new clip.

## 5. Chrome constraints and how they are handled

| Constraint | Handling |
|---|---|
| The service worker can stop at any time | All state in storage; alarms drive checks; single-flight ticks; restore on startup |
| Alarms fire at most every 30 s | Interval in minutes (1–60) |
| Tab media needs a document | Offscreen document (one per extension) hosts the capture engine |
| Tab capture needs a user gesture on that tab | One click arms the recorder tab; the running capture follows the tab's navigations. If it stops, the worker tries to restart it and otherwise shows "video capture inactive" |
| Background tab playback | A captured tab is not throttled; a muted player is detected (silence warning) |
| A WebSocket keeps the worker alive only while active | Twitch keepalive every 10 s; the socket closes when no Twitch session is active |
| Storage quota | Clips are ~0.4 MB/s at 720p; delete from the Clip Library |
