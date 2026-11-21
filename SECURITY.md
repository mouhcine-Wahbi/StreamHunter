# StreamHunter — Security & Privacy

## Principles

1. **Local-first.** There is no StreamHunter server and no account. The monitoring list, highlights,
   clips, settings and credentials stay in the browser profile where the extension is installed.
2. **Your own platform credentials, no secrets in the code.** Nothing secret is in the source or the
   repository. Twitch can run with no secret at all (Sign in with Twitch, implicit grant with a
   checked `state`). YouTube uses an API key for public data only (restrict it to the YouTube Data API
   in Google Cloud). Kick's app-token flow needs your app's secret, kept only in this browser.
   **Own apps (details).** Twitch/Kick client IDs and secrets belong to the editor's own developer
   apps. They are stored in `chrome.storage.local` and sent only to that platform's token endpoint
   (`id.twitch.tv`, `id.kick.com`). They are never logged or shown again after saving (the secret
   field stays empty).
3. **Least privilege for chat.** Sign in with Twitch asks for `user:read:chat`, plus `clips:edit`
   only when the editor turns on "Also create a Twitch clip". The state
   parameter is checked, the token is validated with Twitch, and Sign out revokes it.
4. **Minimal data.** Chat messages are analysed in memory and discarded; only highlights (time, score,
   reasons) are kept, and provisional highlights expire after the retention period.
5. **Explicit consent for capture.** Recording only starts when the editor clicks **Use this tab as
   the recorder** or **Only capture this stream** in the popup on that tab (Chrome requires that
   click). The recorder tab is then navigated only to `twitch.tv/<login>` / `kick.com/<slug>` of
   streamers the editor marked Auto-record. Chrome shows its sharing indicator while it runs, the
   tab stays audible, nothing is encoded while nobody is live or monitoring is paused or stopped,
   and capture ends with **Stop capture** or when the tab closes. Only clips are saved, locally, within the
   storage limit. Nothing is uploaded.
6. **Official APIs only.** Twitch Helix, Twitch EventSub, Kick's public API and the YouTube
   Data API (discovery only). No scraping, no unofficial chat
   sockets, no stream downloaders, no DRM or restriction bypasses.
7. **No automatic publishing.** StreamHunter doesn't connect to social media accounts or post
   anything. It prepares clips, text and a score; you download the files and upload them yourself.
   Rights you record (including "permission to post" and its destinations) are information for you.
8. **AI providers (3.0) are optional and yours.** Only facts about a clip (creator, platform, game,
   detection reasons, length, original link), never video, go to the provider you chose: your
   Anthropic key or your OpenAI-compatible endpoint. The key is kept in `chrome.storage.local` and
   never shown again. Chrome's on-device model runs locally.

## Extension permissions

| Permission | Why |
|---|---|
| `storage` | Settings, credentials, cached tokens, live state |
| `alarms` | Scheduled live-status checks |
| `notifications` | Go-live, highlight and clip-saved notifications |
| `sidePanel` | Highlight feed beside the stream |
| `activeTab` | Read the URL of the tab the popup was opened on (which channel to capture) |
| `tabCapture`, `offscreen` | Capture that tab in an offscreen document |
| `identity` | Sign in with Twitch (`launchWebAuthFlow`) |
| `system.cpu`, `system.memory` | Overload protection while recording several streams (whole-machine CPU and free memory; nothing is sent anywhere) |
| Keyboard shortcut (`commands`, Alt+Shift+R) | Arm the current tab as a recorder; it counts as the click Chrome requires |
| Host access: `api.twitch.tv`, `id.twitch.tv`, `api.kick.com`, `id.kick.com`, `www.googleapis.com/youtube/v3/*`, `www.youtube.com/feeds/*` | The official APIs and YouTube's public upload feed. The Twitch chat WebSocket (`eventsub.wss.twitch.tv`) needs no host permission |

**Optional host access (3.0), asked for only when you set something up:** `api.anthropic.com` or your
own AI endpoint (when you save an AI key). StreamHunter has no access to YouTube, TikTok or X
upload APIs: it never posts. You upload the clips you download yourself.

No `tabs`, `<all_urls>`, `downloads`, `cookies` or content scripts.

## Other measures

* Messages to the worker are accepted only from this extension's own pages (`isTrustedSender`), are
  type-checked (`isRuntimeRequest`) and their inputs validated (tab ids, seconds clamped to 5–110).
* The page that opens a stream only builds `https://www.twitch.tv/<login>` / `https://kick.com/<slug>`
  from validated names.
* Platform errors are shown without credentials or tokens in them.
* Clip downloads are blob URLs created in the extension page; they are revoked when the card unmounts.

## What the editor should know

* Anyone with access to this Chrome profile can see the saved app credentials and clips. Use a
  profile you control, and **Remove** credentials in Settings → Platforms when you're done.
* The same goes for AI keys (3.0): remove them in Settings → AI when you no longer need them.
  StreamHunter stores no social media accounts or tokens; publishing accounts saved by earlier 3.0
  test builds are deleted on update.
* Clips and highlights are deleted when the extension is removed or its site data is cleared.
