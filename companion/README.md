# StreamHunter Companion

An optional local program for StreamHunter 4.0. Chrome starts it (native messaging) when the
extension needs FFmpeg, Whisper, yt-dlp or Remotion, and it exits when Chrome disconnects.
StreamHunter works without it; automatic editing and the YouTube Video Clipper need it.

## Install (once per Chrome profile)

```bash
brew install ffmpeg openai-whisper yt-dlp deno node   # Node 22 or later
cd companion
npm ci                  # Remotion 4.0.545 + React, pinned (needed only for the motion template)
node install.mjs --extension-id <ID from StreamHunter → Settings → Companion>
```

Then in StreamHunter → Settings → Companion click **Allow and connect** (Chrome asks once for the
"Communicate with cooperating native applications" permission).

Remove the registration: `node install.mjs --uninstall` (the work folder is kept; delete it yourself
if you want).

The installer writes only:

* `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.streamhunter.companion.json`
  (allows exactly one extension ID),
* `~/Library/Application Support/StreamHunter/bin/streamhunter-companion` (launcher) and `config.json`.

## How it works

* Control messages (JSON) over native messaging, stdin/stdout, 1 MB per message from the companion.
* Video files over HTTP on `127.0.0.1` only, a random port and a random 64-hex token per launch. The
  token is handed over through native messaging and kept in the extension's service worker memory.
  Every request needs the token, this extension's `Origin`, and the loopback `Host` (no DNS rebinding).
* Files live only in the work folder (`files/`, `jobs/`, `tmp/`, `logs/`); names are plain
  (`[A-Za-z0-9._-]`, no `..`). Uploads stop when less than 2 GB would stay free.
* Only fixed requests: `hello`, `tools`, `disk`, `files/delete`, `shutdown`, and for editing
  `edit/start`, `transcribe/start`, `fetch/start`, `jobs/get`, `jobs/list`, `jobs/cancel`, `jobs/remove`. No arbitrary commands, no shell:
  FFmpeg runs with arguments built from a checked edit plan (`src/plan.mjs`).
* Editing (`src/jobs.mjs`): one job at a time, saved in `jobs/`, restarted after an interruption, FFmpeg
  at lower priority, progress sent to Chrome as events, cancel removes partial files, every output is
  probed and fully decoded before it's offered. Inputs and outputs are deleted once the extension has
  saved the Short.
* Motion template (`remotion/`, `src/render.mjs`): after FFmpeg makes the vertical Short, Remotion
  adds a gentle zoom (at most 1.15×) on the gameplay at the strongest moment and a quick fade in; the
  facecam panel is never zoomed. It runs as its own process (its memory and CPU are measured, cancel
  stops it and its headless browser). The installer downloads Remotion's headless Chrome **once**
  into `node_modules/.remotion`; renders use that exact file and never download anything. Without
  Remotion the Short is still made, without motion, and says so.
* Transcripts (`src/transcript.mjs`, request `transcribe/start`): the openai-whisper CLI with the
  `large-v3-turbo` model, word timestamps, on this computer. The model (about 1.6 GB) is downloaded
  once by you (`whisper --model large-v3-turbo <any audio file>`); the companion never downloads it
  and says so if it is missing. Whisper invents text over sound with no speech (in testing: "Thank
  you." and "I'll see you next time." over a steady tone, with a no-speech probability of 0), so every
  word is checked against the sound: speech rises and falls between syllables, a tone, hum or silence
  doesn't. Words without speech-like sound under them are dropped (and listed as dropped), as are
  repeated text and Whisper's own "no speech" segments. Kept text is Whisper's, unchanged. Captions in
  edited Shorts are built from these words only when you turn Captions on (off by default).
* yt-dlp (`src/fetch.mjs`, request `fetch/start`, 4.6): **off unless you turn on Settings → YouTube
  Clipper → "Allow the download tool"**, and only for a video you confirm (in the Clipper, per
  video) is your own or that you have written permission to download. The companion accepts only an 11-character video id
  and builds the URL itself. yt-dlp always runs with `--ignore-config --no-cookies
  --no-cookies-from-browser --no-playlist` and never with cookies, a login, netrc, a client
  certificate or extra headers (checked before every run). The video's details are checked first;
  private, members-only, paid, sign-in-required, age-restricted, live or upcoming and DRM-protected
  videos are refused, and a refusal is never retried another way. Downloads go to `tmp/`, are limited
  to 1080p and 4 GB, are probed and compared with the video's length, and only then moved to
  `files/`. YouTube's terms may not allow downloading even your own videos with third-party tools;
  you decide whether you may use it.
* **Remotion licence and network:** Remotion is free for individuals and companies of up to three
  people; larger companies need a company licence (remotion.dev/license). No licence key is passed,
  so Remotion sends **no usage event**; nothing leaves this computer while rendering.
* Clean-up (4.7): at every start, leftovers in `tmp/` are removed, finished jobs the extension never
  collected are forgotten after 7 days (with their files), files no job refers to are deleted after
  24 hours, and damaged job records are removed. No job starts with less than 2 GB of free disk.
* Logs: `logs/companion.log` (rotated at 5 MB). Stdout is reserved for Chrome.

## Tests

```bash
npm test   # node --test (Remotion tests are skipped when it isn't installed)
```
