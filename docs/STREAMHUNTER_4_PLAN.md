# StreamHunter 4.0 — Audit and plan (for approval)

_Written 2026-11-23 on branch `streamhunter-3.0` (at `052a7dd`, in sync with GitHub). Nothing has been
installed or changed yet. Numbers marked "measured" were measured on this Mac today._

## 1. Current architecture (3.0)

A Manifest V3 Chrome extension with no backend. Everything is local:

| Part | What it does |
|---|---|
| Service worker (`src/background/`) | Monitoring and scheduler, discovery (Twitch, Kick, YouTube Data API), recording approvals, chat signals, notifications, alarms, the processing queue manager, metadata + score (`content-manager`) |
| Offscreen document (`src/offscreen/`, `src/processing/`) | Tab capture and the rolling buffer; WebCodecs demux/decode/encode; layout analysis (facecam, action, centre) and the vertical 9:16 + landscape transcodes; file analysis (loudness moments) |
| Extension pages (`src/pages/`, React) | Overview, My Creators, Find Creators, Live Monitoring, Content Discovery, Clip Queue, Clip Library, Short-form Clips, X Clips, System Health, Settings |
| IndexedDB `streamhunter` v4 | streamers, sessions, highlights, clips + clipBlobs/clipThumbs, candidates (discovered videos, never downloaded), sources + sourceBlobs (your authorized files, max 4 GB), assets + assetBlobs (vertical / landscape versions), rights |
| chrome.storage.local | settings, credentials, scheduler/capture state |

## 2. Existing recording and clipping pipeline

1. Monitoring finds a live creator → you approve the broadcast → a recorder tab is captured in the
   offscreen document with a rolling buffer.
2. Signal fusion (audio, chat, visual, viewers) detects a moment → a highlight → the buffer around it
   is cut into a real MP4 clip (`clips`, `clipBlobs`).
3. The processing queue (offscreen, WebCodecs, one job at a time) makes the vertical 9:16 version
   (facecam above gameplay / follow the action / centre crop, per creator or per clip) and the
   landscape version.
4. When a version is ready, `content.prepare` writes the viral-potential score (six explained
   factors) and the title/description/hashtags per platform.
5. Authorized files you add (`sources`) are analysed for loud moments; you pick moments and they are
   cut into clips the same way.
6. The Clip Library shows everything; you download and upload yourself.

**What 4.0 can reuse:** the score, the per-clip layout decision (facecam rectangle, action crop),
moments analysis, rights records, metadata generation, the Library, the queue patterns
(one-at-a-time, persisted, resumed on start).

## 3. The five tools on this Mac

Mac: Apple M5 (10 CPU cores, 8-core GPU, Metal 4), 16 GB RAM, macOS 26.7.1, 360 GB free.
Chrome 158. Node 22.23.5 and Python 3.15 via Homebrew.

| Tool | On this Mac | License | Fit |
|---|---|---|---|
| **FFmpeg** | ✅ 9.0.2 (Homebrew), VideoToolbox H.264/HEVC encoders, `loudnorm` | GPL v3 build (`--enable-gpl --enable-version3`, libx264) | Run as a separate process (no linking). Fine for your own use; StreamHunter doesn't redistribute it. This build has **no `drawtext`/`subtitles`** (no freetype/libass), so all text and captions come from Remotion |
| **Whisper** (openai-whisper) | ✅ 20250625 (Homebrew), PyTorch 2.15 with MPS, `large-v3-turbo` model already downloaded (1.6 GB) | MIT (code and weights) | Measured: 20 s of audio in 12.9 s on CPU, 5 GB peak memory. **It printed "Thank you." for a clip with no speech** (a known Whisper hallucination), so transcripts need guards (see §5) |
| **yt-dlp** | ✅ 2026.10.26 (Homebrew) with Deno 2.9.8 (YouTube now needs a JS runtime) | Unlicense | The tool is fine; the problem is YouTube's terms (see §8). Disabled by default, gated by rights |
| **Remotion** | not installed; npm 4.0.545 | Remotion License: free for an individual or a company with ≤ 3 employees, otherwise a paid Company License | Renders React compositions with its own Chrome Headless Shell and its own bundled FFmpeg (downloaded on first render, inside the companion's `node_modules`). Has a `hardwareAcceleration` option |
| **HyperFrames** (HeyGen) | not installed; npm 0.9.84, first release March 2026, 668 releases since | Apache-2.0 | HTML-based compositions rendered the same way as Remotion (headless Chrome frame capture + FFmpeg), Node ≥ 22. **Duplicates Remotion** and is pre-1.0 with very fast churn |

Measured FFmpeg, 20 s 1080p → 1080×1920 with loudness normalization: VideoToolbox 2.4 s wall /
2.9 s CPU / 259 MB; x264 veryfast 1.3 s wall / 8.6 s CPU / 633 MB. VideoToolbox is the default
while streams are recording (far less CPU).

### Remotion or HyperFrames?

Both render a composition by screenshotting headless Chrome frame by frame, then encoding with
FFmpeg. Using both would mean two renderers, two template systems and two headless browsers.

**Recommendation: Remotion only.** Its compositions are React and TypeScript, like the rest of
StreamHunter, it is stable (4.x), and templates can share types with the extension. HyperFrames'
advantages (Apache license, plain HTML for AI-generated layouts) don't outweigh the duplication now.
I will not install HyperFrames. If you'd rather avoid Remotion's license terms, HyperFrames can
replace Remotion one-for-one in the same slot. **You need to confirm you qualify for Remotion's
Free License (individual or ≤ 3 employees).**

### Whisper engine

Use the installed openai-whisper (the one you named) through its CLI. whisper.cpp with Metal would
be faster and lighter and could be offered later; I won't add it now to avoid duplicates.

## 4. Where each tool runs

**None of the five can run inside a Chrome extension** (no process spawning, no file system, no
headless browser). They run in a **local companion**:

```text
Chrome extension (unchanged 3.0 + new screens)
   │  chrome.runtime.connectNative("com.streamhunter.companion")   ← control: start, status, cancel (JSON)
   ▼
StreamHunter Companion (Node 22, launched by Chrome, stops when Chrome disconnects)
   ├── 127.0.0.1:<random port>, per-launch random token, Origin checked   ← file transfer only
   ├── job queue (persisted JSON, one job at a time, cancellable, resumable)
   ├── ffmpeg / ffprobe   (Homebrew)          cut, crop, mux, loudnorm, encode, validate
   ├── whisper            (Homebrew)          transcripts (optional)
   ├── yt-dlp + deno      (Homebrew)          only for allowed sources (off by default)
   └── @remotion/renderer (companion's node_modules) compositions and templates
   work folder: ~/Library/Application Support/StreamHunter/ (jobs, sources, outputs, tmp; with quotas)
```

* **Native messaging** is the Chrome-approved way for an extension to talk to a local program.
  Messages from the host are limited to 1 MB, so video files go over the localhost HTTP channel
  (the token is handed over through native messaging; the server accepts only that token, only
  from this extension's origin, only on 127.0.0.1).
* The companion exposes **fixed operations with validated parameters** (edit this clip with this
  template, transcribe, analyse, fetch this YouTube video id). It never runs arbitrary commands,
  never passes cookies to yt-dlp, and only reads and writes inside its work folder.
* **Without the companion, StreamHunter 3.0 keeps working exactly as now.** Auto-editing and the
  YouTube Video Clipper show "Companion not installed" with setup steps. No cloud is involved.
* The host manifest must list the extension ID. The extension is loaded unpacked, so its ID comes
  from its folder. Adding a fixed `key` would change the ID and **lose all data in the current
  install** (IndexedDB is per ID), so I won't. The installer takes the ID shown in Settings instead.
* Install: `npm install` in `companion/`, then `node companion/install.mjs <extension-id>`. It
  writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.streamhunter.companion.json`,
  checks FFmpeg/Whisper/yt-dlp/Deno versions, and runs `npx remotion browser ensure`.

## 5. Automatic editing (livestream clips)

1. A clip's score is computed as now. New settings: **auto-edit from 85**, **offer editing from 70**
   (both configurable). 85–100 → queued automatically; 70–84 → "Edit" button; below 70 → nothing.
2. Only a **vertical 1080×1920 Short** is made automatically. Landscape/X versions are never auto-edited.
3. Edit job in the companion, one at a time:
   1. Receive the original MP4 and the layout decision StreamHunter already made (facecam
      rectangle, action crop path, or centre).
   2. `ffprobe` checks the input (detects corrupt files).
   3. Optional transcript (Whisper), only where there is speech energy. Segments with Whisper's
      `no_speech_prob` above a threshold, or text that doesn't line up with audible speech, are
      dropped, so silence never becomes words.
   4. Edit plan (deterministic, from measured signals only): trim dead air at the start so the
      Short opens on the action when the clip supports it, one controlled punch-in zoom (≤ 1.15×)
      at the measured peak, a short clean transition only where a cut exists. Nothing is invented;
      no fake text, events or speech.
   5. Remotion renders the template (facecam above gameplay, action-follow crop, or centre fallback).
   6. FFmpeg muxes the original audio (loudness-normalized to about −14 LUFS when enabled), encodes
      H.264 + AAC with `+faststart`, then validates (streams, duration, full decode pass).
   7. The output and a thumbnail come back to the extension as a new **edited** version. **The
      original clip and its existing versions are never overwritten.**
4. Captions: off by default; when you enable them, they're rendered by Remotion from the
   transcript only.
5. Editing styles: one preset at first, **Clean gaming / livestream**, structured so more presets
   can be added (zoom strength, transition style, safe areas, caption style).
6. Resource control: one job at a time; the companion runs at lower priority (`nice`); Remotion
   concurrency capped (about half the cores); editing waits while recordings run and the machine is
   under load (reusing the existing overload signals); progress persisted; cancel kills the child
   process; interrupted jobs resume; duplicates prevented by a key (clip + template + settings
   hash); temporary files deleted after import; quotas for the work folder.

## 6. YouTube Video Clipper

1. **Search** (YouTube Data API `search.list` with your existing key, 100 quota units per search)
   or **paste a URL**. Results show thumbnail, title, channel, URL, duration (from `videos.list`,
   1 unit), published date.
2. **Select a video** → source details.
3. **Rights step:** you choose own content / explicit permission / licensed (for example Creative
   Commons) and add evidence (a link or a note). The existing rights record is reused. The screen
   states plainly that YouTube availability and your confirmation in StreamHunter are not proof
   of permission. The rights status stays visible on every later step.
4. **Approve or reject** the source before anything is retrieved.
5. **Retrieval:**
   * **Default: import the authorized file.** For your own videos this is YouTube Studio's own
     download button (a method YouTube itself provides), then import the file into StreamHunter.
   * **yt-dlp, only if you turn it on** in Settings and the rights record says "permission to
     download" with evidence. The companion builds the URL from the video id itself, checks with
     yt-dlp first that the video is public or unlisted, not live, not age-restricted, members-only,
     paid or DRM-protected, and refuses otherwise. It never uses cookies or sign-in.
6. **Analysis:** loudness moments (existing analyser) plus Whisper transcript, then **candidate
   segments** with timestamps, a score and the reason (measured loudness, speech excerpt).
7. **Approve/reject each segment** → extracted clips (originals) → segments that reach the
   auto-edit threshold are edited into vertical Shorts automatically; others offer "Edit".
8. Long sources stay on disk in the companion's work folder (not in IndexedDB, which is limited),
   with a size limit and a delete button.

## 7. New database structures (IndexedDB v5)

| Store / change | Contents |
|---|---|
| `assets.kind` gains `"edited_vertical"` | Edited Shorts sit next to the original's versions: template, template version, edit-plan summary, validation result, metrics (render time, peak memory) |
| `editJobs` (new, index on `dedupe_key`) | clip id, source kind (livestream / YouTube), template, settings hash, state (queued → uploading → transcribing → rendering → encoding → validating → importing → ready / failed / cancelled), progress, step, attempts, error, companion job id, timestamps |
| `transcripts` (new) | per clip or source: language, model, segments with word timings, dropped-segment count, created_at |
| `sources` extended | origin `youtube` with video id, channel, URL, duration, thumbnail, approval (pending / approved / rejected), retrieval method (import / yt-dlp), `stored_in` (IndexedDB / companion folder) |
| `segments` (new, index on `source_id`) | candidate segments: start, end, score, reasons, transcript excerpt, status (pending / approved / rejected / extracted), clip id |
| settings | `editing` (enabled, autoFrom 85, offerFrom 70, style, captions false, loudness on, encoder VideoToolbox/x264, fps, pause while recording), `companion` (none secret), `clipper.allowDownloadTool` false, storage quotas |

The companion keeps its own `jobs.json` for crash recovery; IndexedDB stays the source of truth.

## 8. Platform and licensing limits

* **YouTube Terms of Service** forbid downloading content "except (a) as expressly authorized by the
  Service; or (b) with prior written permission from YouTube and, if applicable, the respective rights
  holders", and forbid automated access. yt-dlp is not a method YouTube authorizes. So:
  * the authorized default is **YouTube Studio download (your own videos) → import**;
  * yt-dlp is off by default, and turning it on is your decision, for sources where you have that
    permission. StreamHunter can record the permission; it cannot verify it.
* yt-dlp works by solving YouTube's player challenges. Whether that counts as getting around a
  technical measure is a legal question in some countries; this is another reason it stays opt-in.
* **The YouTube Data API** is used only for search and metadata (no downloads), within the 10,000
  units/day default quota (about 100 searches/day).
* **Remotion** is free for individuals and companies with ≤ 3 employees; otherwise a Company
  License is required. Its license will "slightly change" in Remotion 5.0.
* **FFmpeg** (GPL build) is used as a separate program you installed; nothing is redistributed.
* **Whisper** makes mistakes, including invented text on silence or music; transcripts feed
  metadata only as quotes with their timestamps, and only after the guards in §5.
* Chrome: native messaging needs the host manifest per Chrome profile and the `nativeMessaging`
  permission; Chrome Web Store distribution would need a fixed ID later.

## 9. New screens and workflow

* **YouTube Video Clipper** (new): search + URL input, results, selected video details, rights step,
  approve/reject source, retrieval and analysis status, candidate segments with timestamps and
  scores, approve/reject per segment, editing status per Short.
* **Editing queue** (in Clip Queue): each job's state, progress, step, error, cancel and retry.
* **Clip Library**: a type filter and labels for livestream clips, imported YouTube videos,
  candidate segments, extracted clips and edited Shorts. Each Short shows thumbnail and preview,
  creator, original URL, timestamp, score and why, the template used, title/description/hashtags,
  Download MP4 and Copy metadata.
* **Settings → Editing** and **Settings → Companion** (status, versions, install steps, work folder
  size and cleanup). **System Health**: companion card (connected, tool versions, queue, CPU and
  memory of the last job).

## 10. Phases

Each phase ends runnable, with tests, real files, a real-Chrome check and a report. Nothing is
pushed without your approval.

| Phase | Content | Verified with |
|---|---|---|
| 4.1 Companion | Node native host, localhost file channel, install script, tool version checks, status in Settings/Health | unit tests (protocol, token, Origin, path safety); real Chrome connectNative handshake and a 50 MB transfer |
| 4.2 Editing queue + FFmpeg editing | DB v5, edit jobs, auto-queue ≥ 85 / Edit button 70–84, FFmpeg-only vertical edit (layout crops, loudness, encode, validate), import as edited version, Library shows both | real clips edited; ffprobe + full decode; playback checked; CPU/memory measured; cancel/resume/duplicate tests |
| 4.3 Remotion templates | Remotion installed in the companion; Clean gaming template (facecam split, action crop, centre fallback, punch-in at peak, clean opening); style setting | rendered real Shorts checked frame by frame; render time and memory measured |
| 4.4 Whisper | optional transcripts with hallucination guards; facts for metadata; captions (off by default) | real speech and no-speech files (the no-speech file must produce no text) |
| 4.5 YouTube Video Clipper | search/URL, details, rights, approve/reject, import path, segments, per-segment approval, auto-edit | real Data API search with your key; a real authorized file through the whole flow |
| 4.6 yt-dlp (opt-in) | gated retrieval, availability checks, no cookies, refusal cases | only on a video you confirm you may download |
| 4.7 Storage + hardening | quotas, cleanup, corrupted-file handling, recovery, docs, full regression | full suite + real-Chrome regression of 3.0 features |

## 11. What I need from you

1. Approve the plan (or change it).
2. Confirm you qualify for Remotion's Free License, or choose HyperFrames instead.
3. Decide whether yt-dlp should exist in 4.0 at all (opt-in as above) or be left out, with import only.
4. For phase 4.5: a YouTube video you own (or have written permission for) to test with.
