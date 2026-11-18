# StreamHunter

**Find the moment. Capture the clip.**

StreamHunter is an automatic clipping assistant for video editors, for Twitch and Kick. Pick the
streamers, arm a recorder tab once, click **Start monitoring** and leave the computer running.
StreamHunter switches the recorder tab to whichever selected streamer is live, listens to the
sound, watches the picture, reads Twitch chat and viewer numbers, and when several of those react
together it saves an MP4 clip. Come back to a library of ranked clips ready to review and download.

Everything runs **inside your browser**. There is no StreamHunter server, no account and no upload:
your monitoring list, highlights and clips live in this browser (IndexedDB), and StreamHunter talks
to Twitch and Kick directly through their official APIs with your own free developer apps.

> **Status:** v1.2, automatic clipping of several streams at once, local-first. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for what is
> verified and how.

## How it works

| Mode | What it uses | What you get |
|---|---|---|
| **Discovery** (background) | Live status, title, category and viewers of your monitoring list (one batched request per platform every couple of minutes); Twitch chat over EventSub after "Sign in with Twitch" | Go-live notifications and **provisional highlights** (a time, a score, the reasons, **Open stream**). No video, and they are labelled that way |
| **Automatic recording** (recorder tab) | One tab you arm once from the popup. StreamHunter navigates it to the live **Auto-record** streamer, encodes video and audio into a rolling buffer (2 minutes by default), and records nothing while nobody is live | Moments where several signals fire together become **MP4 clips** with a thumbnail, stored in the browser |
| **Manual capture** | The stream open in the current tab | Same detection, plus **Save last 30 s** |

### How a clip is decided

Each signal is measured against the stream's own normal and gets an intensity (0–100):

| Signal | What counts | Points at full strength (configurable) |
|---|---|---|
| Audio | Louder than usual, sudden bursts, shouting-like, cheer-like and laughter-like sound | 25 |
| Chat (Twitch) | Message-rate spikes, repeated reactions (LOL, LMAO, WTF…), emote waves, many chatters at once | 30 |
| Visual | Fast motion, rapid scene changes, flashes | 20 |
| Viewers | Sudden viewer-count jumps (raids) | 15 |
| Several kinds together | Bonus | 10 |

Signals close together form one moment. A clip is saved when the moment's score reaches the
threshold (40 by default), so **no single signal makes a clip on its own**. Overlapping moments
extend one clip (up to 90 s) instead of saving the same footage twice. A clip covers 20 s before
and 20 s after the moment. Audio cues are signal-processing heuristics, not a trained classifier,
and are labelled "-like".

StreamHunter never says a clip exists when it only saw chat or viewer numbers.

## Features

| | Status |
|---|---|
| Search Twitch channels by name; look up Kick channels by exact name; live-now lists for both | ✅ |
| Monitoring list: live/offline, title, category, viewers, avatar, last check, Open stream | ✅ |
| Background live-status checks (batched, rate-limit aware), sessions per broadcast, go-live notifications | ✅ |
| Chat-based detection: spikes vs each stream's own normal, emote waves, repeated messages, "clip it", reactions in 8 languages, mood shifts | ✅ Twitch (needs Sign in with Twitch) |
| Viewer-spike detection (raids, sudden attention) | ✅ Twitch and Kick |
| Recorder tab: automatic channel switching, idle while offline, stream restarts | ✅ |
| Signal fusion with configurable weights and threshold, no duplicate clips | ✅ |
| Rolling buffer (60–300 s), 20 s / 20 s around each moment, MP4 + JPEG thumbnail | ✅ |
| Start / Pause / Resume / Stop monitoring, five-stage pipeline status | ✅ |
| Overview (status, streamers, clips, recording time, storage), Top Highlights (ranked clips, filters: score, recent, streamer, platform, category, duration, detection type), Clip Library (preview, download MP4, rename, delete, favourite) | ✅ |
| Storage limit and age limit with automatic cleanup (favourites kept) | ✅ |
| Optional native Twitch clip for each clip | ✅ opt-in (needs `clips:edit`) |
| Several streams recorded at once (Settings → Recording: 1–8, default 1), one recorder tab each, independent detection and clips, per-stream Pause/Resume/Stop/Listen | ✅ verified with 3 in Chrome |
| Overload protection: CPU, free memory, dropped frames, storage → half frame rate, then pause the lowest-priority stream | ✅ |
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
2. **My Streamers**: turn on **Auto-record** for the streamer(s) you want clipped.
3. Open `twitch.tv` (or `kick.com`) in a tab, click the StreamHunter icon and choose **Use this tab
   as the recorder**. Chrome requires this one click; leave the tab open (it can be in the
   background) and the player unmuted.
   For several streams at once, set **Settings → Recording → Simultaneous streams** and arm one tab
   per stream (the icon, or **Alt+Shift+R** on the tab). Each tab records a different live
   Auto-record streamer (favourites first, then most viewers).
4. **Start monitoring** and leave the computer running. The **Pipeline** panel shows each stage:
   channel discovery, chat, video capture, detection, clip export.
5. Come back to **Top Highlights** (ranked) and the **Clip Library** to preview, favourite and
   download.

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
* **Video only exists while a recorder tab runs.** Chrome needs one click on a tab before it can be
  captured; after a Chrome restart or if the recorder tab is closed, arm it again (the Pipeline
  panel says so). A moment found from chat while nothing was recorded has no video.
* **One recorder tab per simultaneous stream**, each armed with one click per Chrome session (a tab
  can't be captured twice). Measured on an Apple M5 / 16 GB: recording costs about 0.1–0.15 CPU core
  per stream; each real Twitch player adds roughly 0.15–0.3 core and 300–600 MB (estimate) and
  6–8 Mbit/s of download. 3 streams are comfortable on such a Mac, 5 if little else runs.
* With several streams, only one plays its sound (Listen per stream); all are recorded with sound.
* The recorder tab plays the stream: pre-roll ads and "mature content" gates on the platform's page
  are recorded too or can block playback. Muting the player mutes the capture (a warning appears
  after 20 s of silence).
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
