# StreamHunter

**Find the moment. Capture the clip.**

StreamHunter is a Chrome extension for video editors and clipping teams. Search Twitch and Kick
streamers, keep a monitoring list, and let StreamHunter watch it in the background: it notices when
streamers go live and when their chat or audience suddenly reacts. Open a stream and capture it,
and the moments it detects become real MP4 clips, ranked by score, in your Clip Library.

Everything runs **inside your browser**. There is no StreamHunter server, no account and no upload:
your monitoring list, highlights and clips live in this browser (IndexedDB), and StreamHunter talks
to Twitch and Kick directly through their official APIs with your own free developer apps.

> **Status:** v1.0, local-first. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for what is
> verified and how.

## How it works

| Mode | What it uses | What you get |
|---|---|---|
| **Discovery** (background, no stream open) | Live status, title, category and viewers of your monitoring list (one batched request per platform every couple of minutes); Twitch chat over EventSub after "Sign in with Twitch" | Go-live notifications and **provisional highlights**: a time, a score and the reasons, plus an **Open stream** button. No video, and they are labelled that way |
| **Capture** (you open the stream and click Capture) | The tab's video and audio, encoded in the browser into a 2-minute rolling buffer | Detected moments (chat, loud audio, fast action, flashes) and "Save last 30 s" become **MP4 clips** (H.264 + AAC) stored in the browser |

StreamHunter never says a clip exists when it only saw chat or viewer numbers.

## Features

| | Status |
|---|---|
| Search Twitch channels by name; look up Kick channels by exact name; live-now lists for both | ✅ |
| Monitoring list: live/offline, title, category, viewers, avatar, last check, Open stream | ✅ |
| Background live-status checks (batched, rate-limit aware), sessions per broadcast, go-live notifications | ✅ |
| Chat-based detection: spikes vs each stream's own normal, emote waves, repeated messages, "clip it", reactions in 8 languages, mood shifts | ✅ Twitch (needs Sign in with Twitch) |
| Viewer-spike detection (raids, sudden attention) | ✅ Twitch and Kick |
| Highlight notifications with **Open stream** | ✅ |
| Capture mode: rolling buffer, loudness / motion / flash detection, automatic clips, Save last 30 s | ✅ |
| Top Highlights (ranked, filter by platform/status/video) and Clip Library (preview, rename, download MP4, delete) | ✅ |
| Kick chat | 🚫 Kick only sends chat to servers (webhooks) |

## Requirements

* Google Chrome 116+ (or another Chromium browser with WebCodecs)
* Node.js 20+ and npm 10+ to build
* A free **Twitch** developer app and/or **Kick** developer app (see below)

## Build and load the extension

```bash
cd extension
```

```bash
npm ci
```

```bash
npm run build
```

Then in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `extension/dist`.
3. Pin StreamHunter in the toolbar. The workspace opens on first install.

During development, `npm run dev` rebuilds `dist/` on every change (reload the extension card to
pick up service-worker or manifest changes).

## Set up Twitch and Kick

StreamHunter uses **your own** developer apps: an extension can't keep a shared secret, and your own
app gives you your own rate limit. Both are free.

**Twitch**

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**.
2. OAuth Redirect URL: copy the one shown in **Settings → Platforms → Twitch** (it looks like
   `https://<extension-id>.chromiumapp.org/`). Category: anything. Client type: **Confidential**.
3. Copy the **Client ID**, create a **Client Secret**, paste both in **Settings → Platforms → Twitch**
   and click **Save and test**.
4. For chat-based highlights, click **Sign in with Twitch** (permission: read chat).

**Kick**

1. Go to [kick.com/settings/developer](https://kick.com/settings/developer) and create an app
   (redirect URL: any, e.g. `http://localhost`).
2. Paste the **Client ID** and **Client Secret** in **Settings → Platforms → Kick** → **Save and test**.

The credentials are stored only in this browser (`chrome.storage.local`) and sent only to that
platform's token endpoint.

## Using it

1. **Discover**: pick Twitch or Kick, browse who's live or search a channel, click **Add**.
2. **Live Monitoring → Start monitoring**. StreamHunter checks your list every 2 minutes (Settings →
   Monitoring) while Chrome is open. Sessions open when a streamer goes live.
3. When a moment is detected you get a notification. **Open stream** takes you there.
4. On the stream tab, click the StreamHunter icon → **Capture this stream**. From then on, detected
   moments for that streamer become clips automatically; **Save last 30 s** clips on demand.
5. Review in **Top Highlights** and download from the **Clip Library**.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The tests run against an in-memory fake of the Chrome APIs, a fake IndexedDB and a fake Twitch/Kick
that follows the documented request and response shapes. Chat detection is tested on a seeded chat
simulator. The MP4 muxer runs for real.

## Known limitations

* Monitoring runs **only while Chrome is open**.
* **Kick chat isn't available**: Kick delivers chat only to a public server via webhooks. Kick
  discovery uses live status and viewer spikes.
* **Video only exists for captured streams.** A moment found from chat while nobody captured the
  stream has no video. Chrome needs your click on the stream tab to capture it, so capture can't
  start automatically.
* The capture buffer holds the **last 2 minutes**, in memory. Keep the stream tab open while
  capturing; muting the player also mutes the capture.
* Clips are cut on keyframes (every 2 s), so they can start up to 2 s early. They keep the tab's
  framing (no 9:16 reframing or subtitles; edit them in your editor).
* Twitch's Sign in with Twitch token can expire; sign in again when chat shows as unavailable.
* Clips live in this browser's storage. Download the ones you want to keep; clearing site data for
  the extension deletes them.

## Documentation

* [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit, platform APIs, Chrome constraints
* [API_DOCUMENTATION.md](API_DOCUMENTATION.md): the internal local API and the platform endpoints used
* [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md): IndexedDB stores and chrome.storage keys
* [SECURITY.md](SECURITY.md): permissions, credentials, privacy
* [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): what works and how it was verified
* [docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md): why and how StreamHunter moved from a backend to local-first
