# StreamHunter — Security & Privacy

## Principles

1. **Local-first.** There is no StreamHunter server and no account. The monitoring list, highlights,
   clips, settings and credentials stay in the browser profile where the extension is installed.
2. **Your own platform apps.** Twitch/Kick client IDs and secrets belong to the editor's own developer
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
6. **Official APIs only.** Twitch Helix, Twitch EventSub and Kick's public API. No scraping, no
   unofficial chat sockets, no stream downloaders, no DRM or restriction bypasses. Nothing is
   published anywhere.

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
| Host access: `api.twitch.tv`, `id.twitch.tv`, `api.kick.com`, `id.kick.com` | The official APIs. The Twitch chat WebSocket (`eventsub.wss.twitch.tv`) needs no host permission |

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
* Clips and highlights are deleted when the extension is removed or its site data is cleared.
