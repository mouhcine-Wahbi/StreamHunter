# StreamHunter Companion

An optional local program for StreamHunter 4.0. Chrome starts it (native messaging) when the
extension needs FFmpeg, Whisper, yt-dlp or Remotion, and it exits when Chrome disconnects.
StreamHunter works without it; automatic editing and the YouTube Video Clipper need it.

## Install (once per Chrome profile)

```bash
brew install ffmpeg openai-whisper yt-dlp deno node   # Node 22 or later
cd companion
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
* Only fixed requests: `hello`, `tools`, `disk`, `files/delete`, `shutdown` (more arrive with the
  editing phases). No arbitrary commands, no shell.
* Logs: `logs/companion.log` (rotated at 5 MB). Stdout is reserved for Chrome.

## Tests

```bash
npm test   # node --test, no dependencies
```
