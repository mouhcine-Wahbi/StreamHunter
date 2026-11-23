# StreamHunter — Implementation Status

_Last updated: 2026-11-21 (3.0 in progress, branch `streamhunter-3.0`)_

Legend: ✅ done & verified · 🟡 partial · ⏳ not started · 🚫 not possible with official APIs

## v4.0 — in progress (branch `streamhunter-3.0`, plan in docs/STREAMHUNTER_4_PLAN.md)

### Phase 4.1 — Local companion (native messaging)

| Item | Status | Evidence / notes |
|---|---|---|
| Companion (`companion/`, Node 22+, no dependencies): native messaging framing (1 MB limit to Chrome, 64 MiB from Chrome), fixed requests only, exits when Chrome disconnects, logs to a file | ✅ unit + end-to-end tests; tested in real Chrome | Real Chrome 158: Chrome started it, it stopped when Chrome quit |
| File channel on 127.0.0.1: per-launch token, Origin and Host checks, safe names, size limit, 2 GB disk reserve, no partial files left | ✅ unit tests; tested in real Chrome | 50 MB extension page → companion → back: sha256 identical both ways; 49 ms up, 69 ms down; a request without the token got 401 |
| Tool detection with versions and minimums (FFmpeg incl. VideoToolbox / x264 / loudnorm, FFprobe, Whisper, yt-dlp, Deno) | ✅ unit tests; real tools on this Mac | FFmpeg 9.0.2, Whisper 20250625, yt-dlp 2026.10.26, Deno 2.9.8 found; a check takes about 5 s (Whisper's Python import) |
| Installer: host manifest for one extension ID, launcher (paths with spaces and quotes), uninstall | ✅ unit tests; used for the real-Chrome run | Run against a test Chrome profile only; **not installed in your own Chrome yet** |
| Extension: optional `nativeMessaging` permission, companion client (connect on demand, idle disconnect after 5 min, protocol check, Chrome errors in plain words), Settings → Companion, System Health card | ✅ unit + UI tests; Settings and Health checked in real Chrome | The permission prompt itself can't be clicked by automation: the real-Chrome run used a copy of the build with the permission required. **Clicking "Allow and connect" in the real prompt is unverified** |
| 3.0 unaffected | ✅ 230 extension tests + 10 companion tests, build | |

## v3.0 — in progress (branch `streamhunter-3.0`, not released)

Same labels as v2.0 below. 2.0 is kept intact; the backup tag `backup/v2.0-before-3.0` points at the last 2.0 commit.

### 3.0 summary (phases 1–11 implemented)

**Product decision (phase 11): no automatic publishing.** StreamHunter prepares clips, versions,
text and a score; you download the MP4s and upload them yourself. The YouTube / TikTok / X
publishing integrations built in phases 7–8 (sign-in, upload jobs, retries, notifications, Studio,
Performance, publishing settings, the TikTok token server) were removed. Discovery and monitoring
of YouTube, Twitch and Kick are unchanged. No social media account is needed.

**Tested for real (Chrome 158, Apple M5):**
* Recording approvals.
* Vertical and landscape formats with all three layouts, checked frame by frame.
* Analysing and cutting authorized files.
* The processing queue's lifecycle (run again after the removal).
* On-device AI detection (reports "downloadable" on this Mac) with the template fallback.
* Score and text written automatically for every new clip.
* Clip Library with real processed clips: status, per-version downloads, recommendation, Copy all
  (the clipboard held the YouTube title, description and hashtags).
* Database upgrade from a profile made by the publishing build: the jobs store is dropped, clips kept.

**Tested only against fake servers built from each platform's documentation:**
* Claude and OpenAI-compatible metadata generation.

**Not verified yet:**
1. Metadata from a real Anthropic key or a real local model server, and from Chrome's on-device
   model once downloaded (about 22 GB).
2. The in-page video preview player. The automated Chrome never plays video; the files were checked
   with ffprobe and ffmpeg instead.
3. CPU impact of processing while several streams are recording.
4. The old "sh-publishing" timer being replaced on a real extension update. Unit-tested; in the
   automated Chrome a copied old profile kept running its cached old service worker, so the update
   path couldn't be observed there.
5. Clicking a download in a real (non-automated) Chrome window and opening the saved file.

### Phase 3 — Recording approvals and recording integration

| Feature | Status | Evidence / notes |
|---|---|---|
| Nothing is recorded without your approval of that broadcast | ✅ tested for real + unit tests | Real Chrome, real live Twitch page (caseoh_): recorder tab armed before any approval stayed idle ("Waiting for your approval"); after clicking **Record** in the dashboard it recorded at 24–30 fps within 6 s |
| One request per broadcast, tied to its identity, no repeated notifications | ✅ tested for real + unit tests | Broadcast ID = Twitch stream ID / YouTube video ID / start time / first sighting. Real run: one notification per broadcast |
| Approval expires when the broadcast ends; never carries over | ✅ tested for real + unit tests | Real run: a new broadcast of the same streamer stopped the recording and opened a new request |
| Record / Decline in the desktop notification | ⚠️ notification shown for real; buttons not clicked for real | Chrome allows two buttons. Clicking a notification button can't be automated in the test harness; the same decision path as the dashboard button is unit-tested |
| Remind me later (asks again once, same broadcast; minutes configurable) | unit tests | In Live Monitoring only (third action doesn't fit Chrome's two notification buttons) |
| Decline, Record after all, Stop recording this stream | ✅ decline for real + unit tests | |
| Approved streams queued when all slots are busy, with their position | unit tests (worker + real stored approvals) | "Approved, #2 in the queue: all 3 slots busy." |
| Pending approvals, approved, declined, history in Live Monitoring; Pending approvals tile on Overview | ✅ screenshot (real Chrome) + UI test | |
| Notification settings (requests on/off, reminder minutes) | unit tests | Notifications need Chrome running; nothing is delivered while Chrome is closed or the Mac sleeps |
| Real live-status changes from the platform APIs | 🧪 | Needs your credentials; the real-Chrome run used seeded live state for a real live channel |

"Always approve" is deliberately not offered in this version.

### Phase 4 — Content discovery, rights and authorized sources

| Feature | Status | Evidence / notes |
|---|---|---|
| Latest uploads of your YouTube creators (public feed + `videos.list`, skips live/upcoming) | unit tests against documented responses | 🧪 Needs your YouTube API key to verify for real |
| Trending: YouTube `chart=mostPopular` by region and category; Twitch most-viewed recent clips of the top categories | unit tests against documented responses | 🧪 Needs your keys |
| Keywords: matched to a Twitch category; optional YouTube search (101 units per keyword, off by default) | unit tests | 🧪 Needs your keys |
| Filters: age, views, engagement, language, results per source; deduplication keeps your rights and dismissals | unit tests + settings UI test | |
| Source popularity, always labelled as the original video's (log views/hour + engagement), never as a clip's potential | unit tests | Uses only numbers the platform reports |
| Each source fails on its own, with a plain reason (missing key, quota, network) | unit tests | |
| Rights: unknown / analysis / processing / publishing, each above unknown needs evidence and your confirmation; publishing needs destinations | unit tests | StreamHunter records and enforces what you state; it can't verify it |
| Discovered videos are candidates only: never downloaded or processed | by design + unit tests | You add the file yourself ("Add authorized file…"), which needs at least "Authorized for analysis" |
| Content Discovery page, Settings → Content discovery | UI test | Not yet checked in real Chrome |

### Phase 5 — Processing: vertical 9:16, landscape for X, authorized files

| Feature | Status | Evidence / notes |
|---|---|---|
| Vertical 9:16 (1080×1920, H.264 + AAC) made in the browser (mp4box.js demux → WebCodecs decode → canvas layout → H.264 encode) | ✅ tested for real + unit tests | Real Chrome 158 on an Apple M5: a 20 s 1080p30 clip became 1080×1920 in ~6 s; ffprobe: H.264 + AAC, 20.0 s, decodes with no errors |
| Facecam above gameplay | ✅ tested for real + unit tests | Frame check: the facecam area (set per creator) fills the top (≤ 40% of the height, never stretched), gameplay below |
| Follow the action | ✅ tested for real + unit tests | Moving-square test: kept in frame at 3 s, 10 s, 17 s; the centre crop of the same clip lost it at 3 s and 17 s (as expected). Smoothed, speed-limited; ignores pans and cuts |
| Centre crop fallback (also used when no facecam position is set, with a note saying so) | ✅ tested for real + unit tests | |
| Landscape for X: the original is reused (no copy) when it meets X's limits (≤ 140 s, ≤ 1920×1200, H.264 + AAC, ≤ 512 MB); otherwise re-encoded/shortened, with the reason | ✅ tested for real + unit tests | AAC recording reused; an Opus-audio clip re-encoded to AAC. X's limits are from X's documentation, not yet tested against X itself |
| Every output is demuxed again and checked (size, duration) before it's marked ready | ✅ tested for real | |
| Layout per creator (My Creators, with a preview on their latest clip) and per clip (Short-form Clips → Remake) | UI tests | Priority: clip → creator → Settings default |
| Authorized files: find moments (loudness + visual change, relative to the file itself) and cut clips (3–180 s) | ✅ tested for real + unit tests | Real run: found the loud part at 11 s; an 8 s clip cut and its two formats made. Needs "Authorized for analysis" / "for processing"; MP4/MOV only (no WebM yet) |
| Processing queue in the offscreen document, stored in IndexedDB: survives the document closing, resumes on start and every 5 min, closes the document when done | ✅ tested for real + unit tests | A race (document closed before a new clip's formats were queued) was found in the real run and fixed |
| Preview player in Short-form Clips / X Clips | ⚠️ not verified | The automated Chrome used for tests never plays any video (even a plain data: URL), so the in-page player couldn't be checked; the files themselves were checked with ffprobe/ffmpeg |
| Processing while recording | 🧪 | Both run in the same offscreen document; CPU impact on a live recording not measured yet |

### Phase 6 — Metadata and viral-potential score

| Feature | Status | Evidence / notes |
|---|---|---|
| Title / description / caption / post and hashtags per destination (YouTube Shorts, TikTok, X), built only from facts StreamHunter has (creator, platform, game, detection reasons, length, original link) | ✅ unit + UI tests; tested in real Chrome (templates) | Generators may phrase the facts; invented links are removed |
| Platform limits enforced on every output, including your edits: YouTube title 100 / description 5000; TikTok caption 2200; X 280 with links counted as 23; hashtag caps 5 / 5 / 2 | unit tests | Limits are from the platforms' documentation, not yet checked against the platforms themselves |
| Creator credit ("Credit: <creator> on <platform> <link>"), on by default, setting to turn off | unit + UI tests | |
| Fallback order: Chrome on-device AI → your own provider → local templates; every skipped option's reason is shown | unit tests; on-device availability tested in real Chrome | Real Chrome 158: `LanguageModel` is present in the service worker and reports **downloadable** (the model isn't on this Mac), so the real run correctly fell back to templates with the reason shown. **On-device generation itself has not run for real**; StreamHunter never starts the ~22 GB download on its own |
| Your provider: Claude with your own Anthropic key (official SDK, `claude-opus-5-5` by default, structured JSON output, server-side refusal fallback enabled) or any OpenAI-compatible endpoint (e.g. a local model server) | 🧪 tested against a fake API | The Claude request was checked through the real SDK against a fake endpoint (URL, auth, model, JSON schema). **Not tested with a real Anthropic key or a real local server.** Keys stay in this browser; Chrome asks for permission to contact the provider when you save a key |
| Your edits are kept when the text is written again; "replace my edits" resets them | unit + UI tests | |
| Viral-potential score 0–100: six factors with your weights (hook, emotion, audience reaction, build-up, shareability, platform fit), each listing what it measured | unit + UI tests; shown in real Chrome | An estimate from measurements, never a view prediction |
| Tiers: high ≥ 85 (your threshold) = strong candidate; medium ≥ 60 = worth reviewing; low = probably not worth posting. High with confidence < 50% becomes medium | unit tests | Confidence = share of the weight that was actually measured × the detector's confidence |
| Settings: score weights and thresholds; AI (on-device on/off with its state, provider, model, endpoint, key — never shown again after saving) | typecheck + existing Settings tests | Key saving needs Chrome's permission prompt, not exercised in automation |

### Phases 7–8 — Publishing (removed in phase 11)

Publishing jobs for YouTube Shorts, TikTok and X, the Publishing Studio, Performance and the
publishing settings were built and tested against fake servers only, then **removed** at your
request: StreamHunter doesn't post. Their history is in commits `42841b8` and `c316dca`.

### Phase 9 — Tests and hardening

| Item | Status | Evidence / notes |
|---|---|---|
| No content scripts are injected, so stored credentials and keys are readable only by the extension's own pages and worker | code review | |
| Full suite: 223 tests after phase 11 (unit, UI, fake platform servers) | ✅ | `npx vitest run` |
| Real Chrome regression (Phase 5 run again with everything on): formats made, analysis and cut worked, then score + text were written for each new clip, offscreen document closed | ✅ tested for real | Chrome 158, Apple M5 |

### Phase 11 — Publishing removed; Clip Library for manual upload

| Item | Status | Evidence / notes |
|---|---|---|
| Removed: publishing modules (accounts, platforms, checks, runner, plan), jobs, Studio and Performance screens, Settings → Publishing, Overview publishing tiles, System Health publishing card, publishing notifications, `publish/run` message, the TikTok token server, and the googleapis / X / TikTok optional host permissions | ✅ typecheck, tests, build | `identity` stays (Twitch sign-in); YouTube discovery keeps its fixed `youtube/v3` host permission |
| Kept: discovery and monitoring (YouTube, Twitch, Kick), clip generation, vertical and landscape versions, score, per-platform titles / descriptions / hashtags, creator credit, rights, downloads | ✅ full suite; processing run again in real Chrome | |
| Update from the publishing build: database v4 drops the jobs store; saved publishing accounts deleted; old timer replaced by a maintenance timer; settings keep your credit choice and score thresholds under the new names | unit tests; DB upgrade tested in real Chrome | See "Not verified" item 4 |
| Clip Library: preview of each version; creator, platform, source link (or "from your file"); detection time and offset; score with reasons; platform recommendation from the platform-fit factor; each format with its status; a separate download per version | ✅ UI test; tested in real Chrome | |
| Copy title (YouTube only; TikTok and X have no title field), description, hashtags, and all, per platform | ✅ UI test; Copy all tested in real Chrome | Copying needs the window focused (browser rule); the button says "Copy failed" otherwise |
| Filters: creator, format, minimum score, detection date range, status (generating / ready / failed) | ✅ UI test | |
| Works with no social media account: no publishing screens, settings or connect buttons | ✅ UI test | |

## v2.0 — Multi-platform automatic clipping (released)

Labels: **✅ tested for real** (real Chrome, real live pages) · **🧪 implemented, tested against documented
responses** (simulated platform, not the real service) · **⚠️ partial** · **❌ not implemented** · **🚫 blocked
by the platform or browser**.

| Feature | Status | Evidence / notes |
|---|---|---|
| Platform adapter interface (Twitch, Kick, YouTube) | ✅ code + 🧪 | One interface; capabilities report support and how each was verified |
| Twitch: search, live status, viewers, live-now | 🧪 | Real API needs your app; documented shapes tested |
| Twitch without a client secret (Sign in with Twitch token) | 🧪 | Helix calls use the user token, no token endpoint |
| Twitch chat signals | 🧪 | EventSub after Sign in with Twitch |
| Kick: lookup, live status, viewers, live-now | 🧪 | Real API needs your app |
| Kick chat | 🚫 | Kick delivers chat only to servers (webhooks) |
| YouTube: add by link/@handle/ID/video, live status (feed + videos.list), viewers, quota budget, errors | 🧪 | Real Data API needs your key; no search for live checks (≈ 1 unit per check) |
| YouTube search / live now | ⚠️ 🧪 | 100 units each, on request only |
| YouTube chat | 🚫 | Polling cost would exhaust the daily quota |
| Recording a real Twitch, Kick and YouTube live page | ✅ | Three slots at once: Kick (eray), Twitch (typicalgamer), YouTube (Lofi Girl), ~30 fps each, real sound (−14 to −45 dB) |
| Scheduler: explainable priority, queue, fill free slots, keep healthy recordings | ✅ + unit tests | Real run: 3 highest-priority streamers recorded, the lower-priority one queued with its reason |
| Automatic slot reassignment when a stream ends | ✅ | Real run: Kick streamer marked offline → its slot moved to the queued Twitch streamer |
| Switch safeguards (minimum time, cooldown, margin, pending clips, one switch per run) | unit tests | Pure scheduler tests; a priority-driven switch was not exercised in real Chrome |
| Failure detection and retry (no picture / black / silent+motionless → release, retry 2/5/15 min) | ✅ no picture · unit tests for the rest | Real run: YouTube tab frozen → failed after 45 s, slot released, retry scheduled. The silent+motionless rule was added after the real run showed a YouTube "Something went wrong" page that the frozen rule missed |
| Clips: MP4 + sound, thumbnail at the peak, metadata, score explanation | ✅ | Real clips from all three platforms play in Chrome (1280×720 + AAC); an automatic 43 s clip of a real Kick stream |
| Clip lifecycle (generating / ready / failed) and restart recovery | ✅ | Real run: Chrome killed while a clip was generating → after restart it is "failed: Chrome or StreamHunter stopped…" |
| MP4 download from the Clip Library | ✅ | Real run: a 16 MB MP4 saved by Chrome's download |
| Storage limits and cleanup (favourites kept) | ✅ | Real run: an old clip deleted, an old favourite kept |
| Storage-full errors, low-disk warning, persistence request | unit tests | Quota exhaustion was not reproduced for real |
| Dashboard: Overview, My Streamers, Live Monitoring (scheduler), Top Highlights, Clip Library, System Health, Settings | ✅ renders (preview) + UI tests | |
| Overload protection with real CPU/memory readings | ✅ readings (v1.2 run) + unit tests | |
| Several real players for hours, Mac sleep | ❌ not tested | Recording stops if Chrome closes or the Mac sleeps |
| Excluded on purpose: Shorts/vertical, subtitles, editor/timeline, learning from feedback, social transforms, ZIP/batch download | ❌ by design | |

**Found and fixed during the 2.0 real-Chrome runs:**
* A scheduling error (a streamer without a channel name) could leave an engine encoding while its slot
  showed "not recording". Each slot is now isolated; an error stops encoding and is shown.
* The worker dropped the engine's `droppedRecent`, so v1.2's overload protection never saw dropped
  frames.
* A YouTube player error page wasn't detected as a failure: added the silent+motionless rule.
* A saved clip's stored status stayed "generating" (only the computed one was right); fixed.
* Restart clean-up now runs before the first live check.

**Known limitation seen in the real run: Chrome records the whole tab**, including the platform's
page around the player (chat column, menus, a cookie banner). Player-only pages were tried: Twitch's
popout player and Kick's player page don't start playing without a click inside the page, and
YouTube's embed refuses to load without a referring page (Error 153). So StreamHunter records the
normal channel page. Switching each recorder tab to theater mode once (the platforms remember it)
makes clips mostly the stream.

## v1.2 — Several streams at once ✅

| Item | Status | Notes |
|---|---|---|
| One engine per recorder tab in the offscreen document; slot-addressed messages | ✅ verified in Chrome | 5 tabs at 30 fps each in a capability test; a tab can't be captured twice |
| Assignment of live Auto-record streamers to slots (priority, sticky, no duplicates), limit 1–8 (default 1) | ✅ | Default keeps v1.1 behaviour; lowering the limit stops the newest slots |
| Per-stream Pause/Resume/Stop/Listen; global Pause keeps the editor's own pauses | ✅ | Found by a test: Pause → Resume monitoring used to clear a stream you had paused yourself |
| Overload protection (CPU, memory, dropped frames, storage) | ✅ tested on rules; ran in Chrome without false alarms after the fix below | |
| Streams grid, System card, Settings → Recording (limit, 720p/480p, sound, protection), Alt+Shift+R | ✅ | |
| Tests | ✅ | 125 |

**Real-Chrome check (Chrome 157, Apple M5, 16 GB):**

* Two recorder tabs, two live Auto-record streamers → each tab navigated itself to a different real
  Twitch channel, 2 engines, only the first played sound.
* Three streams of the scripted test page at once: each slot fused and clipped its own laugh +
  action (score 55 ×3), none clipped action alone (20), and only the slot that also got a chat signal
  clipped its later laugh (56; the others scored 25). 4 MP4s (1280×720 + AAC, 48–49 s) play cleanly;
  the Top Highlights ranking spans all three streamers. All three at 30 fps with 0 dropped frames;
  Chrome used ≈ 0.7 of one core in total, the Mac 24–29% CPU. A fourth stream was refused at the limit.
* *Found and fixed:* real offline Twitch pages deliver only 3–14 fps (static page), which the first
  version took for overload and then refused new streams with a stale verdict. Overload now means
  dropped frames, CPU or memory sustained for ~30 s; the verdict is cleared when recording stops; the
  memory floor is 1 GB because macOS reports ~2 GB "available" on a busy 16 GB Mac.

**Not measured:** several real live Twitch players at once over hours (player decode cost, network).

## v1.1 — Automatic clipping ✅

Plan: [docs/AUTO_CLIPPING_PLAN.md](docs/AUTO_CLIPPING_PLAN.md). Start monitoring, leave Chrome
running, come back to ranked clips.

| Item | Status | Notes |
|---|---|---|
| Recorder tab: armed once, navigated to the live Auto-record streamer, idle while nobody is live, reload on stream restart, restart attempt if the engine stops | ✅ verified in Chrome | Chrome needs one click per tab; a running capture keeps going through navigations (tested same-site and cross-site) |
| Signal fusion (audio 25 / chat 30 / visual 20 / viewers 15 / multi 10, threshold 40, all configurable) | ✅ | One signal alone never clips with the defaults; Settings warns if weights allow it |
| Overlaps: extend a pending clip (≤ 90 s), merge into a saved one, never duplicate footage | ✅ | `ClipPlanner` |
| Audio: louder than usual, sudden bursts, shouting-like, cheer-like, laughter-like (envelope rhythm) | ✅ | Heuristics, labelled "-like" |
| Visual: fast motion, rapid scene changes, flashes | ✅ | |
| Chat and viewer moments of the recorded streamer become fusion signals; absorbed provisional highlights are merged | ✅ | |
| Buffer 60–300 s (≥ pre + post + 70 s), 20 s / 20 s, MP4 + JPEG thumbnail at the peak | ✅ verified in Chrome | |
| Start / Pause / Resume / Stop monitoring; five-stage pipeline (discovery, chat, video, detection, export) | ✅ | "Live and detected, but video capture inactive" when no recorder runs; silence warning for a muted player |
| Overview (status, streamers, clips, recording time, clip footage, storage), Top Highlights (ranked clips, 6 filters), Clip Library (preview, download, rename, delete, favourite) | ✅ | Provisional moments kept in a separate, clearly labelled list |
| Storage limit (default 5 GB) and optional age limit, favourites never deleted | ✅ | After every clip |
| Optional native Twitch clips (`POST /helix/clips`, `clips:edit`) | 🟡 | Implemented, off by default; **not run against real Twitch** |
| Several streams at once | ⏳ | One recorder tab; the engine and director are per tab so more can be added |
| Tests | ✅ | 114 (fusion, planner, auto-clipper, audio/visual features, recorder director, storage limits, clip filters, pause/resume, UI) |

**Real-Chrome check (Chrome 157, built extension):**

* *Recorder:* armed on a tab with no Auto-record streamer live → 150 frames read, **0 encoded**.
  Streamer marked live → the tab navigated itself to `twitch.tv/twitch` and 150 chunks were encoded in
  5 s. Marked offline → encoding stopped again (0 chunks in 5 s).
* *Automatic clipping* on a scripted test stream (calm picture and quiet noise, then events):
  laugh + fast action at t=50 s → score 55, **clipped**; action alone at t=80 s → score 20,
  **not clipped**; laugh + a chat signal at t=110 s → score 56, **clipped** (audio + chat). Two MP4s
  (48.7 s and 49.0 s, 1280×720, H.264 + AAC) that play in Chrome with no dropped frames, without
  overlapping footage, each with a thumbnail of the peak (t=52.2 s and t=114.7 s on the page clock).
* *Found and fixed:* a single step in loudness scored as "laughter-like" (the rhythm check now
  needs a real oscillation); repeated reason variants ("5 in 4 s", "13 in 4 s") are now one line.

**Not verified yet:** real Twitch/Kick APIs and Twitch chat (no app credentials on this machine), a
real Twitch player in the recorder tab over hours (ads, mature-content gates, autoplay muting).

## v1.0 — Local-first, search-first ✅

No backend: one Chrome extension, data in IndexedDB, Twitch/Kick called directly with the editor's
own developer apps. Plan and API analysis: [docs/LOCAL_FIRST_MIGRATION.md](docs/LOCAL_FIRST_MIGRATION.md).

| Item | Status | Notes |
|---|---|---|
| Local store (IndexedDB) + local API with the pages' existing paths | ✅ | `src/local/`. Unknown paths are a local 404; nothing is fetched from a server |
| Twitch Helix / Kick public API clients, editor's own app credentials | ✅ tested against a fake | Settings → Platforms, Save and test. Token cache, one retry after 401, 429 waits honoured, batching 100 / 50 |
| Discover: search, Twitch/Kick filter, live now, viewers, category, avatar, Add, Open stream | ✅ | Kick: exact channel name (no search API) |
| Background monitoring: alarm → batched status check → sessions → notifications | ✅ | Degraded/offline states name the platform and reason. Pause on stop, resume the same broadcast |
| Chat detection ported to TypeScript (same rules and scenarios as the backend's tests) | ✅ | 17 tests on a seeded chat simulator |
| Twitch chat via EventSub WebSocket + Sign in with Twitch | ✅ tested against a fake socket | Subscribe per live streamer, unsubscribe when offline, refusal reported. **Not yet run against real Twitch** (needs credentials) |
| Kick chat | 🚫 | Official delivery is webhooks to a public server only |
| Viewer-spike highlights (Twitch and Kick) | ✅ | ≥ 1.5× and +100 over the broadcast's median |
| Provisional highlights with Open stream notifications | ✅ | Labelled "provisional · no video" everywhere |
| Capture mode: tab video/audio → WebCodecs → 2-min rolling buffer → MP4 clips in IndexedDB | ✅ verified in Chrome | See below |
| Live capture signals: loudness, fast action, flashes → automatic clips; chat/viewer highlights of the captured streamer clip too; Save last 30 s | ✅ | |
| Top Highlights (ranked, video filter) and Clip Library (preview, rename, download MP4, delete) | ✅ | |
| Retention of provisional highlights and ended sessions | ✅ | Clips are kept until deleted |
| Backend removed | ✅ | `backend/` deleted; in git history before the v1.0 commit |
| Tests | ✅ | Extension 92 (local API, platform clients, monitoring, chat manager, detection, capture buffer/mux/signals, capture manager, UI) |
| Real-Chrome check | ✅ | Chrome 157, built extension loaded unpacked, a tab playing a test video (moving test pattern, quiet tone, a real laugh at 40 s). **Save last 12 s** → a 12.1 s MP4, H.264 1280×720 302 frames + AAC 48 kHz stereo, decodes cleanly with FFmpeg, frame shows the tab. **Automatic**: after 30 s of learning, the laugh was detected ("Stream audio 21 dB louder than usual") and a 30.0 s clip saved by itself, the laugh at 18–27 s of it. The pan and the flash alone stayed below the minimum score, as designed |

**Found and fixed during the check:** capturing a static tab gives no video frames (Chrome only
produces frames when the page changes); the test harness had picked the blank start tab.

**Not verified yet:** real Twitch and Kick API responses and real Twitch chat (no app credentials on
the development machine). The request and response shapes follow the platform documentation.

## History: backend era (Phases 0–7, retired in v1.0)

Everything below was built with a FastAPI backend, which v1.0 replaced. Features that have no
in-browser equivalent were removed: accounts, Twitch clip creation through the API, uploading
recordings for analysis, FFmpeg exports with 9:16 reframing, burned-in subtitles (faster-whisper)
and YAMNet laughter detection.

## Phase 0 — Inspection & planning ✅

| Item | Status | Notes |
|---|---|---|
| Repository inspection | ✅ | The directory was empty, so this is a new project |
| PROJECT_PLAN.md / ARCHITECTURE.md | ✅ | |
| Kick API research | 🟡 | Read from the official `KickEngineering/KickDevDocs` repo. docs.kick.com and the OpenAPI spec were unreachable from the dev container, so the exact query parameters must be confirmed |
| Twitch API research | 🟡 | dev.twitch.tv was unreachable from the dev container. The facts come from prior knowledge and are marked unverified |

## Phase 1 — Extension foundation ✅

| Item | Status | Notes |
|---|---|---|
| Vite + React 19 + TS (strict) + Tailwind 4 | ✅ | `extension/` |
| Manifest V3 (popup, side panel, module service worker) | ✅ | Minimum permissions |
| Full-page workspace with 7 sections + hash navigation | ✅ | |
| Popup control center | ✅ | Status, live count, recent highlights, start/stop, open workspace/side panel |
| Side panel highlight feed | ✅ | |
| Dark theme / design tokens / accessible components | ✅ | Buttons, cards, badges, switch, fields, segmented, empty states |
| Settings persisted in `chrome.storage.local` with validation | ✅ | Sanitized on read and write |
| Background worker: alarms, typed messaging, badge | ✅ | |
| Monitoring state machine + exponential backoff + restore on startup | ✅ | The backend side of the lease comes in Phase 4 |
| API client (timeouts, typed errors, bearer auth) | ✅ | |
| Truthful backend states (unreachable / 404 / 401) in every view | ✅ | No sample data anywhere |
| Unit/component tests | ✅ | 49 tests (Vitest + Testing Library + fake Chrome APIs) |
| Real-browser check (Chromium + built extension) | ✅ | Load, popup, all routes, settings across reload, heartbeat → active, state across worker stop. No unexpected console errors |

### What works right now, without a backend
The extension installs and opens. Navigation and settings work. Monitoring can be
switched on and off and honestly shows **Backend offline** with backoff.

### What waits on the backend
Every data view (watchlist, search, sessions, highlights, clips, platform
connections) already calls its real `/api/v1` endpoint. Until that endpoint exists,
the view says so ("Backend not reachable" or "Not available on this backend").

## Phase 2 — Backend foundation ✅

| Item | Status | Notes |
|---|---|---|
| FastAPI app factory, consistent error envelope, JSON logging with secret redaction | ✅ | `backend/app/` |
| SQLAlchemy 2 (async) models for all 10 tables + UTC-safe datetime type | ✅ | SQLite (aiosqlite); PostgreSQL via asyncpg URL |
| Alembic initial migration | ✅ | Tested: upgrade matches the models exactly; downgrade is clean |
| Health `/health`, `/api/v1/health` (with DB check) | ✅ | |
| Accounts: register / login / logout / me | ✅ | Argon2id, opaque revocable sessions (only hashes stored), uniform login errors, rate limiting |
| Watchlist API (search, list, add, get, patch, delete) | ✅ | Ownership-scoped, no duplicates, shared channel rows, per-user monitoring flag |
| Streams, monitoring sessions/events, highlights, clips: read endpoints | ✅ | Real DB queries with filters and pagination. Writes come in Phases 4–6 |
| Settings API (GET/PATCH, validated deep merge) | ✅ | The extension still stores settings locally; syncing comes in Phase 4 |
| Platform adapter interface + registry + capability reporting | ✅ | `StreamingPlatform` ABC; Twitch/Kick report real config state |
| Twitch/Kick API calls | ⏳ | Return 503 `platform_not_configured` or 501 `not_implemented`, never fake results |
| Clip status state machine (publish requires confirmation) | ✅ | `app/domain/status.py`, ready for Phases 5–6 |
| Token encryption utility (Fernet) | ✅ | Used once OAuth tokens are stored (Phase 3) |
| Extension: account sign-in / register / sign-out, 401 → "Sign in" action | ✅ | Data views refetch after sign-in |
| Backend tests | ✅ | 40 pytest tests |
| Extension tests | ✅ | 53 Vitest tests |
| Real stack check | ✅ | Built extension in Chromium + live uvicorn: sign-up, Overview counts, capabilities, Discover error. No console errors |

**Known gaps at the end of Phase 2**
* The monitoring heartbeat endpoint does not exist yet. Starting monitoring therefore shows
  *Degraded: this backend does not provide the monitoring endpoint (404)*. Phase 4 adds it.
* The data-retention cleanup job is not implemented yet (Phase 4). No chat data is collected yet, so nothing accumulates.

## Phase 3 — Twitch & Kick integration ✅ (code complete; live API check pending credentials)

| Item | Status | Notes |
|---|---|---|
| Shared HTTP layer: timeouts, retry on 5xx/network, rate-limit handling, error mapping | ✅ | `integrations/http.py` |
| App access tokens (client credentials), cached, renewed after 401 | ✅ | Both platforms |
| Twitch: search, channel lookup, batched live status (100 ids/request), title, category, viewers, start time | ✅ | Helix |
| Kick: channel lookup by exact name, profile picture, batched live status, title, category | ✅ | Kick has no search API; field names unverified (see ARCHITECTURE §3) |
| Account connections: authorize, callback, status, disconnect | ✅ | Twitch code flow; Kick code + PKCE; tokens encrypted; refresh before expiry |
| Capability reporting from real config + connection state | ✅ | |
| `POST /streams/refresh` and fresh `GET /streams/{id}/status` | ✅ | Skips streamers checked < 30 s ago |
| Extension: Connect/Disconnect, connected-as badge, Refresh status, last-checked times, Kick exact-name hint | ✅ | |
| Tests | ✅ | Backend 55 (mocked Twitch/Kick APIs) + 2 opt-in live tests; extension 57 |
| Live stack check | ✅ | Real uvicorn + built extension: capabilities, authorize URLs (PKCE for Kick), forged callback rejected, consent tab opens. Platform calls fail cleanly with `platform_unreachable` because Twitch/Kick are unreachable from the dev container |
| **Calls to the real Twitch/Kick APIs** | ⏳ | Needs credentials + network: `pytest -m integration` |

**Acceptance status:** searching both platforms, live status, and title/category all work against
mocked platform APIs with documented response shapes. The one remaining check, *"results are real
when credentials are configured"*, can only be confirmed with real credentials on a machine that can
reach Twitch and Kick.
## Phase 4 — Browser monitoring ✅

| Item | Status | Notes |
|---|---|---|
| Lease: start / heartbeat / stop / status endpoints | ✅ | TTL = max(360 s, 3 × interval + 60 s); stop releases immediately |
| Background scheduler (asyncio, in-process) | ✅ | Idle without leases; never crashes on a failed cycle |
| Batched status polling paced by user interval, ≥ `MIN_POLL_SECONDS` | ✅ | One platform call per batch, shared between users |
| Per-platform exponential backoff on outages (30 s → 15 min) | ✅ | Found during the live check: without it a down platform was retried every tick |
| Session lifecycle: open on live, end on offline, pause on lease loss, resume same broadcast, new session on restarted broadcast, end when monitoring is disabled or the streamer is removed | ✅ | `monitoring/reconciler.py` |
| Outage ≠ offline: unknown status never ends a session | ✅ | |
| "Went live" desktop notifications (opt-in) via heartbeat `since` | ✅ | `notifications` permission added; clicking opens Live Monitoring |
| Settings sync extension → backend (when signed in) | ✅ | The browser is the source of truth; `backendUrl` stays local |
| Retention sweep (events, OAuth states, old auth sessions) | ✅ | Hourly |
| Extension: Live now list, named sessions, live/active counts, recovery after worker restart | ✅ | |
| Tests | ✅ | Backend 66; extension 60 |
| Live stack check | ✅ | Built extension + uvicorn with scheduler: account, settings sync, start → lease active, worker stop → state and alarm kept, stop → lease released, scheduler polling with growing backoff (30 s, 60 s) while Twitch was unreachable |

**Not verifiable here:** real go-live/offline transitions need reachable platforms and credentials.
They are covered by tests that drive a fake platform through every transition.
## Phase 5 — Chat intelligence ✅ (live chat pending credentials)

| Item | Status | Notes |
|---|---|---|
| Rolling windows + per-stream baseline + per-user cap | ✅ | `detection/window.py` |
| Detectors: chat spike, emote wave, repeated phrase, clip request, multilingual reactions, sentiment shift | ✅ | 8 language packs + custom phrases from Settings |
| Bot, command and broadcaster filtering; spam resistance | ✅ | Tested: one spammer, bots and commands produce nothing |
| Event aggregation, renormalized scoring, evidence-based categories, explanations | ✅ | Missing audio/video are excluded, not counted as zero |
| Sensitivity per user (low / medium / high) on one shared analyzer | ✅ | |
| Candidates with score, confidence, category, reasons, signal breakdown, approximate offsets | ✅ | Status `pending_review` |
| Twitch chat via EventSub WebSocket (welcome, subscribe, keepalive, reconnect, revocation, backoff) | ✅ | Tested against a real local WebSocket server |
| Kick chat via signed webhooks (RSA verify, freshness, replay, key rotation) + subscribe/unsubscribe | ✅ | Request/response field names unverified (see ARCHITECTURE §3) |
| Chat state + reasons on sessions ("Chat unavailable: …") | ✅ | |
| Live chat activity endpoint + UI sparkline | ✅ | Aggregates only |
| Highlight desktop notifications (min score, opt-out) | ✅ | |
| Tests | ✅ | Backend 92 (detection is deterministic across 15 hash seeds); extension 64 |
| Live stack check | ✅ | Built extension + uvicorn: session opens, chat manager tries Kick, the UI shows "Chat unavailable: Kick chat subscription failed: Could not reach Kick" |
| **Real chat from Twitch/Kick** | ⏳ | Needs credentials, a connected Twitch account (`user:read:chat`) or a Kick webhook tunnel, and network access |

**Found and fixed during this phase:** a flaky category result caused by the order language packs
were loaded in (now fixed, with a test that no phrase is ambiguous after normalization).
Repeated common lines ("hi chat") were also creating false candidates; repeated phrases are now
relative to the stream's baseline and can't create a candidate on their own.
## Phase 6 — Clip workflow ✅ (Twitch clip calls pending credentials)

| Item | Status | Notes |
|---|---|---|
| Review: approve / reject / reopen, adjust window and category | ✅ | State machine enforced |
| Twitch Create Clip + confirmation via Get Clips → created / failed with a reason | ✅ | Mocked Helix with processing delay and offline refusal |
| "Moment passed" guard (Twitch clips the current broadcast) with an explicit override | ✅ | 90 s threshold; request lag recorded |
| Auto-capture at detection time (opt-out setting, meets the min score, own token) | ✅ | Never approves or publishes |
| Retry for failed clips | ✅ | |
| Kick manual workflow: instructions, open channel, paste clip URL (validated) | ✅ | Kick has no clip API |
| Title, aspect ratio | ✅ | Stored in StreamHunter (Twitch titles are edited in Twitch's editor via `edit_url`) |
| Export | 🚫 for now | Honest `media_unavailable`; needs an authorized media source (Phase 7) |
| Publish only with explicit confirmation (API and UI) | ✅ | |
| Extension: review actions, clip status on highlights, Clip Library actions, auto-capture toggle | ✅ | |
| Tests | ✅ | Backend 100; extension 68 |
| Live stack check | ✅ | Built extension + uvicorn: Twitch approve → create refused with "Connect your Twitch account…". Kick approve → manual instructions → pasted clip link → export refused honestly → publish after confirmation |

**Found and fixed:** the aspect-ratio selector stretched across the whole clip card; it is now fixed width.
## Phase 7 — VOD & advanced AI ✅ (recordings, subtitles, live tab audio, laughter in recordings and live, on-screen events)

| Item | Status | Notes |
|---|---|---|
| Twitch VOD discovery + timestamped VOD links on highlights | ✅ | Get Videos (archive), matched to the broadcast start; rechecked every 30 min |
| Kick VOD | 🚫 | No official API |
| Authorized media sources: upload (streamed, size limit) or register (per-user folder), rights confirmation | ✅ | Never downloads from platforms |
| Audio analysis (loudness peaks vs the rolling baseline) | ✅ | Real FFmpeg in tests |
| Visual analysis (scene-change density) | ✅ | |
| Context-aware scoring: chat + audio + visual, renormalized | ✅ | `chat_only_score` kept for transparency |
| Audio-only candidates, candidate merging | ✅ | |
| MP4 export: trim, 9:16 / 1:1 / 16:9, loudness normalization, download | ✅ | |
| Recordings panel per session, analysis status, export progress, download, VOD links | ✅ | |
| Subtitles (speech-to-text) | ✅ | faster-whisper, local CPU (optional `requirements-media.txt`). Burned into the export in the same encode, plus a downloadable .srt. Short lines for vertical video. Language detected or chosen |
| Bundled FFmpeg fallback | ✅ | `static-ffmpeg` (optional) is used automatically when `ffmpeg` isn't on PATH |
| Live tab audio (`chrome.tabCapture` + offscreen document) | ✅ | Started from the popup on the stream tab (Chrome needs that click). One RMS loudness value per second → `POST /monitoring/audio` → live highlights get a measured audio signal. Permissions `activeTab`, `tabCapture`, `offscreen` |
| Laughter / cheering / screaming in recordings | ✅ | YAMNet (AudioSet) via LiteRT, local CPU (optional `requirements-media.txt`); model fetched once and SHA-256 checked. Two windows per second (0.5 s hop), a kind = its classes summed and capped at 1; audio streamed from FFmpeg. Audio signal = max(loudness, sound); a clear sound (≥ 45%) names unnamed moments (laughter → funny, cheering → exciting, screaming → unexpected reaction); sound-only highlights; `laughter`/`cheering`/`screaming` stream events. A classifier failure doesn't fail the analysis |
| Live laughter / cheering / screaming (opt-in) | ✅ | Popup checkbox, off by default. Offscreen AudioWorklet → 16 kHz mono (box-filter downsampling) → 5 s batches with 1 s overlap inside `POST /monitoring/audio` → same YAMNet model on the backend, in memory, audio dropped. Live highlights: audio = max(loudness, sound), clear sound names the category, reason "Laughter in the audio (…% match)". Popup shows "Hearing laughter 90%" |
| On-screen events in recordings | ✅ | FFmpeg `signalstats` 4×/s (brightness, motion). Fast action (≥ 2.5× the recording's usual motion, ≥ 8/255, ≥ 2 s; per-second median so a hard cut isn't action) and flashes (brightness +50 and back within 1.5 s; a cut to a bright scene isn't one). Visual = max(cut density, motion score). Names unnamed highlights `gameplay_highlight`; new highlights only with audio ≥ 40; `fast_action` / `screen_flash` events |
| Recognising specific game events (kills, wins, scoreboards) | 🚫 generic | Needs a model per game; the on-screen detector is game-agnostic |
| Tests | ✅ | Backend 136 + 3 that use the real sound model when `SOUND_MODEL_DIR` points to it (incl. real-FFmpeg on-screen events); extension 101 (downsampling, overlapping batches, opt-in flow). Earlier count: backend 129 + 2 (incl. real-FFmpeg media and subtitle tests; speech and sound models are faked otherwise); extension 94 |
| Live stack check | ✅ | Built extension + uvicorn: uploaded an MP4 via the file picker → FFmpeg analysis (1 audio peak, 2 scene cuts, 2 highlights enriched) → approve → export → downloaded 1080×1920 H.264/AAC, 25.0 s. Subtitles (2026-11-16): real `base` model on a spoken test recording → accurate 2-cue .srt in 3.9 s, captions visible in the 1080×1920 export; Clip Library switch → export → Download .srt in the browser preview. Sound model (2026-11-17): speech → Speech 0.99, sine → Sine wave 0.92, a synthetic "ha ha" voice → no laughter. Real recordings (Wikimedia Commons, CC BY; not in the repo): three laughter clips → laughter 100% / 51% (named funny) and 41% (event recorded, not named); crowd laughing and applauding → cheering 99%; speech, robot "ha ha" and tones stay at 0–3%. Taking only the single best class from one window per second missed two of the three laughs, so a kind now sums its classes and checks every 0.5 s. Full analysis on the live backend: a 70 s recording with talking and a real laugh at 40 s → laughter 40–48 s; a chat "audience reaction" over it became a funny moment ("Laughter in the audio (100% match)"), and without chat a new funny moment was created. A laugh mixed under louder speech was missed (documented limitation) Live laughter (2026-11-17): real Chrome 157 with the built extension, tab capture of a page looping a real laughter recording, sound detection ticked → every 5 s batch answered `sound_state: receiving` with laughter 65–100% (cheering ≤ 2%, screaming ≤ 14%); the same model on the live path, replayed in 5 s batches with 1 s overlap, gives the same peaks as recordings (100% / 51% / 41%). On-screen events: real FFmpeg test video → burst of noise found as fast action (14.9× usual motion), a 0.3 s white flash found, a single hard cut ignored |

**Found and fixed during this phase:**
* Windows outside the recording got a visual score of 0 (lowering their score) instead of "not measured".
* An unreadable upload returned 500 and leaked the server path; it now returns 400 `invalid_media` with the file name only.
* The Clip Library stopped polling an export that took longer than one refresh; it now polls until the export is done.
* faster-whisper 1.2.1 can't decode files with the current PyAV (19); StreamHunter now passes it the samples FFmpeg already decoded.
* SQLAlchemy didn't install `greenlet` on Apple Silicon (`sqlalchemy[asyncio]` now), and a chat test depended on the time of day.

**Tuning point:** with measured audio, a chat-flagged moment over quiet audio gets a lower combined
score (the specified weights: chat 25 %, audio 30 %, visual 20 %) and may drop below the minimum.
The chat-only score stays visible. Re-weighting needs real-stream data.

## Known platform limitations (by design, not bugs)

| Limitation | Handling |
|---|---|
| 🚫 Kick delivers chat only via webhooks to a public HTTPS server | Kick chat shown as unavailable; Kick uses live status and viewer spikes |
| 🚫 Kick has no search API | Exact channel name lookup |
| Tab capture needs the editor's click on that tab | Detections notify with Open stream; capture is started from the popup |
| Video exists only for captured streams | Provisional highlights are labelled and never offered as clips |
| Monitoring only runs while Chrome is open | Sessions pause on stop and resume within the same broadcast |
