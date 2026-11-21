# StreamHunter

**Find the moment. Capture the clip.**

StreamHunter is an automatic livestream clipping assistant for video editors, for **Twitch, Kick and
YouTube Live**. Add the streamers you care about, start monitoring and leave the Mac running.
StreamHunter checks who is live and picks the most promising streams for its recording slots (3 by
default). It records them in the browser and watches for moments: sound, picture, Twitch chat and
viewer spikes. When several of those react together, it saves an MP4 clip. Come back to a ranked list
of individual clips, ready to download into your editor.

Everything runs **inside Chrome**. There is no StreamHunter server, no account and no
subscription. Your list, clips and settings stay in this browser. StreamHunter talks to each
platform's official API with your own free developer credentials. **StreamHunter never posts
anything:** you download the finished clips and upload them to YouTube Shorts, TikTok, X or anywhere
else yourself. No social media account is needed.

> **Status:** v2.0 released. **3.0 is in progress on the `streamhunter-3.0` branch.** What is tested
> for real, what was tested only against documented responses, and what isn't tested yet is listed in
> [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## What's new in 3.0 (branch `streamhunter-3.0`)

* **Recording only with your approval**, one broadcast at a time.
* **Content discovery** (creator uploads, trending, your keywords) kept separate from
  **authorized sources**: rights levels (analysis → processing → permission to post) need your
  confirmation and evidence. Nothing unauthorized is downloaded.
* **Short-form clips**: vertical 9:16 (facecam above gameplay, follow the action, or centre crop;
  set per creator, override per clip) and native landscape for X. All made in the browser with WebCodecs.
* **Titles, captions and hashtags** per platform (YouTube Shorts, TikTok, X), to copy when you upload: Chrome's on-device AI, then your own provider
  (Claude with your Anthropic key, or an OpenAI-compatible endpoint), then local templates. None of
  them is required, and the creator is credited.
* **Viral-potential score** with six explained factors and a confidence level. High (≥ 85 by
  default) is a strong candidate, medium is worth reviewing, low probably isn't worth posting. It is
  an estimate, never a view prediction.
* **Clip Library** for manual upload: preview every version, see the creator, source, detection
  time, score with its reasons and the best-fitting platform; copy the title, description, hashtags
  or everything per platform; download the original, vertical and landscape MP4s separately; filter
  by creator, format, score, date and status (generating, ready, failed).

## How it works

```text
My Streamers ──► Discovery (live checks every 2 min, official APIs, quota-aware)
                     │ live streamers
                     ▼
                Scheduler ── priority = highlight potential 45% · activity 20% · viewer growth 15%
                     │                   · your priority/favourite 15% · reliability 5%
                     │ best N (default 3), queue for the rest, no needless switching
                     ▼
        Recorder tabs (one per slot) ──► engine per tab: video + audio → 2-minute buffer
                     │                   sound / picture / chat / viewer signals → combined score
                     ▼
                MP4 clips (20 s before + 20 s after, thumbnail, why it scored) → ranked library
```

* **No single signal makes a clip** with the default settings. Audio is worth up to 25 points, chat 30,
  picture 20, viewers 15, plus 10 when several fire together; a clip needs 40.
* **The scheduler explains itself.** Every streamer's priority shows its parts. It keeps healthy
  recordings and switches a slot only when a waiting streamer scores clearly more (12+ points), the
  current recording has run 10 minutes, and no clip of it is still being saved.
* **Honest status.** "Recording" means frames are being encoded right now. A frozen, black or muted
  player is detected and shown. Live streamers that aren't recorded are listed with the reason.

## Platform support

| | Twitch | Kick | YouTube Live |
|---|---|---|---|
| Add by name / link / ID | ✅ | ✅ exact name or link | ✅ link, @handle, channel ID, video link |
| Search | ✅ | ⚠️ no search API: exact name | ⚠️ costs 100 of 10,000 daily quota units, on request only |
| Live status, title, category, viewers | ✅ | ✅ | ✅ public upload feed + 1 batched API call (≈ 1 unit per check) |
| Chat signals | ✅ after Sign in with Twitch | 🚫 Kick sends chat only to servers | 🚫 chat polling would exhaust the daily quota |
| Viewer spikes | ✅ | ✅ | ✅ |
| Recording (tab capture) and automatic clips | ✅ | ✅ | ✅ (ads and autoplay muting apply) |
| Native platform clips | ⚠️ optional (`clips:edit`) | 🚫 | 🚫 |

✅ supported · ⚠️ partial · 🚫 not possible with the official API. Real-world verification per item: see
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Requirements

* Google Chrome 116+ on a Mac (or any desktop Chromium with WebCodecs)
* Node.js 20+ and npm 10+ to build
* Free developer credentials for the platforms you use (below)

## Install

```bash
cd extension
```

```bash
npm ci
```

```bash
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select `extension/dist`. Pin StreamHunter to the toolbar.

To update later, rebuild and click the reload icon on the extension card.

## Platform setup

Each platform uses **your own** free credentials. An extension can't keep a shared secret, and your
own credentials give you your own rate limits and quota. They're stored only in this browser
(`chrome.storage.local`) and sent only to that platform.

**Twitch**
1. [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → Register Your Application. OAuth Redirect URL: the one shown
   in Settings → Platforms → Twitch (`https://<extension-id>.chromiumapp.org/`).
2. Paste the **Client ID** in Settings → Platforms → Twitch. You then have two options:
   * **No secret (recommended):** leave the secret empty and click **Sign in with Twitch**. API calls
     use your sign-in token, so no secret is stored. This also enables chat signals.
   * **With secret:** create a Client Secret and paste it too (app token). Sign in only for chat.
3. **Save and test.**

**Kick**
1. [kick.com/settings/developer](https://kick.com/settings/developer) → create an app (redirect URL: any, e.g. `http://localhost`).
2. Paste the Client ID and Client Secret in Settings → Platforms → Kick → **Save and test**.
   StreamHunter uses Kick's app-token (client credentials) flow, which needs the secret.

**YouTube**
1. [console.cloud.google.com](https://console.cloud.google.com/) → create a project → APIs & Services → **Enable APIs** → *YouTube Data
   API v3*.
2. Credentials → **Create credentials → API key**. Restrict it to the YouTube Data API v3.
3. Paste it in Settings → Platforms → YouTube → **Save and test**. No Google sign-in is needed: only
   public data is read.

## Using it

1. **Add streamers:** in My Streamers, paste names or links, or use Discover. New streamers have
   Ask to record on. Set their priority (−2…+2) or favourite them if you like.
2. **Arm the recorder tabs (once per Chrome session).** Live Monitoring → Scheduler → **Open 3
   recorder tabs**, then press **Alt+Shift+R** in each tab (or click the StreamHunter icon → Use this
   tab as a recorder). Chrome only records a tab after one action of yours on it. StreamHunter then
   moves each tab to the streamer it should record.
3. **Start monitoring** and leave the Mac running and awake.
4. **Approve each stream (3.0).** When a streamer with *Ask to record* goes live, StreamHunter asks
   first, in a notification (Record / Decline) and in Live Monitoring → Recording requests (also
   Remind me later). Nothing is recorded without your approval. An approval covers that one
   broadcast and ends with it; a new broadcast asks again.
5. Come back to **Top Highlights** (ranked; click **Why this score?** on a clip) and the **Clip
   Library** to preview, favourite, rename and **Download MP4**.

Controls: Start / Pause / Resume / Stop monitoring. Each recording slot also has its own Pause,
Stop and Listen (only one stream plays sound; all are recorded with sound).

## Settings worth knowing

| Setting | Default |
|---|---|
| Simultaneous streams | 3 (one recorder tab each) |
| Scheduler weights | 45 / 20 / 15 / 15 / 5, plus minimum recording 10 min, cooldown 5 min, switch margin 12 points, 3 retries |
| Clip | 20 s before, 20 s after, at most 90 s, 2-minute buffer |
| Detection | audio 25, chat 30, visual 20, viewers 15, multi-signal bonus 10, clip at 40 |
| Storage | 5 GB; oldest non-favourite clips deleted first; optional age limit |
| Overload protection | on: half frame rate, then pause the lowest-priority stream |

## Known limitations

* **Recording needs Chrome open, the Mac awake and one action per recorder tab per Chrome session.**
  After a restart, monitoring resumes by itself but the tabs must be armed again. System Health says
  so. Clips that were still being saved at that moment are marked failed, never shown as clips.
* **One tab per simultaneous stream.** A tab can't be recorded twice. Measured on an Apple M5 /
  16 GB: about 0.1–0.15 CPU core per recorded stream plus the platform's own player, and 6–8 Mbit/s
  download per stream. 3 is comfortable, 5 if little else runs.
* **Chrome records the whole recorder tab**, including the page around the player (chat column,
  menus). Player-only pages don't autoplay or refuse to load outside the platform, so StreamHunter
  uses the normal channel page. **Switch each recorder tab to theater mode once** (Twitch Alt+T,
  YouTube T) and accept its cookie banner. The platforms remember it, so clips show mostly the stream.
* **The recorder tab plays the platform's page.** Pre-roll ads, mature-content gates and a muted
  player affect the recording. Muting is detected; a frozen or black player releases the slot and is
  retried after 2, 5 and 15 minutes.
* **YouTube quota:** about 1 unit per live check. Searches and the "live now" list cost 100 units and
  only run when you click.
* **Clips live in browser storage.** StreamHunter asks Chrome to keep it (System Health shows
  whether Chrome agreed), pauses recording below 2 GB free, and deletes the oldest non-favourites at
  your limit. Download the clips you want to keep.
* Audio cues (laughter-, cheer-, shouting-like) are signal-processing heuristics, not a trained model.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "No recorder tab is armed" | Live Monitoring → Open recorder tabs → Alt+Shift+R in each |
| "Live but not recorded: all slots busy" | Raise Settings → Recording → Simultaneous streams, or set priorities |
| "the player shows no picture / a black screen / looks stalled" | Check the tab: player error, ad, consent page, mature-content gate, or the stream ended. It's retried after 2, 5, 15 min |
| "No sound … is the player muted?" | Unmute the platform's player in that tab |
| A platform shows "Problem" in System Health | Read the message: credentials, rate limit (it waits), or YouTube quota (resets at midnight Pacific) |
| "Browser storage is full" | Delete clips, lower the storage limit, or free disk space |

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

248 unit, UI and integration tests (fake Chrome APIs, fake IndexedDB, fake platforms following each
API's documented requests and responses) plus real-Chrome runs. See IMPLEMENTATION_STATUS.md.

## Documentation

* [ARCHITECTURE.md](ARCHITECTURE.md): adapters, scheduler, recording, detection, Chrome constraints
* [API_DOCUMENTATION.md](API_DOCUMENTATION.md): the internal local API and every platform endpoint used
* [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md): IndexedDB stores and storage keys
* [SECURITY.md](SECURITY.md): permissions (and why), credentials, privacy
* [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): what is tested, how, and what isn't
* [docs/AUTO_CLIPPING_PLAN.md](docs/AUTO_CLIPPING_PLAN.md), [docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md): earlier design notes
