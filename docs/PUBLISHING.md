# Publishing (StreamHunter 3.0)

StreamHunter publishes with **your own developer apps** on each platform. No secret is stored in
the extension, and nothing passes through StreamHunter's authors. A clip is marked **Published**
only when the platform confirms the post.

Every job passes these checks before anything is sent, in this order:

1. The destination is turned on (Settings → Publishing).
2. Your rights for the clip's source include publishing to this destination.
3. The account is connected.
4. The right file is ready (vertical for YouTube and TikTok, landscape for X).
5. The text is written.
6. The clip isn't already published there.
7. Potential tier or your approval. **Low** is never automatic. **Medium** waits for your
   approval. **High** is automatic only if automatic publishing is on and confidence is at least 50%.
8. The daily limit for the destination.

Failed uploads retry with backoff (2 min, 4 min, 8 min … up to 1 h) only for network errors,
rate limits and server errors, up to the number of retries in Settings. A job is never retried
automatically if the platform may already have created the post (for example, the connection
dropped while X was creating it). Check your account first.

## YouTube Shorts

- **Your app:** in Google Cloud, create a project, enable the **YouTube Data API v3**, and create an
  OAuth client ID of type **Web application**. Add the authorized redirect URI that StreamHunter
  shows in Settings → Publishing (`https://<extension-id>.chromiumapp.org/`).
- **Sign-in:** Google's OAuth 2.0 for client-side apps (implicit grant), with scopes
  `youtube.upload` and `youtube.readonly`. No client secret. Tokens last about an hour and are
  renewed silently while Google allows it; otherwise you're asked to connect again.
- **Upload:** a resumable upload (`POST /upload/youtube/v3/videos?uploadType=resumable`, then `PUT` the file).
- **Published when:** `videos.list` reports `uploadStatus: processed`. Rejected or failed videos
  show YouTube's reason.
- **Note:** projects that haven't passed Google's audit for the YouTube API upload as private.
  Each upload costs quota.

## X

- **Your app:** in the X Developer Console, set up OAuth 2.0 with app type **Native App** or
  **Single page App** (a public client: no secret). Add the redirect URI shown in Settings → Publishing.
- **Sign-in:** OAuth 2.0 Authorization Code with PKCE (S256). Scopes: `tweet.read tweet.write
  users.read media.write offline.access`. Refresh tokens rotate.
- **Upload:** the v2 chunked media upload (`/2/media/upload/initialize`, `/{id}/append` in 4 MB
  segments, `/{id}/finalize`, then `GET /2/media/upload?command=STATUS` while X processes), then
  `POST /2/tweets` with the media id.
- **Published when:** X returns the new post's id.
- **Note:** your X API plan must allow posting and media upload.

## TikTok

- **Your app:** on TikTok for Developers, add **Login Kit** (Web) and the **Content Posting API**
  with **Direct Post**. Scopes: `user.info.basic`, `video.publish`, and `video.list` (for metrics).
  Register the redirect URI shown in Settings → Publishing.
- **Your token server:** TikTok requires the client secret to stay on a server, so StreamHunter
  sends the authorization code to a small token server **you run**. The server holds your client
  key and secret, and TikTok's token endpoint is `https://open.tiktokapis.com/v2/oauth/token/`.
  StreamHunter makes two kinds of request (`POST`, JSON body):

  ```json
  { "grant_type": "authorization_code", "client_key": "…", "code": "…", "redirect_uri": "…", "code_verifier": "…" }
  { "grant_type": "refresh_token", "client_key": "…", "refresh_token": "…" }
  ```

  Forward each to TikTok as form fields, adding your `client_secret`, and return TikTok's JSON
  unchanged (`access_token`, `refresh_token`, `expires_in`, `refresh_expires_in`, `open_id`,
  `scope`). The server must use https, except on localhost. Allow the extension's origin
  (`chrome-extension://<extension-id>`) if you check origins.
- **Upload:** Direct Post. StreamHunter first calls `creator_info/query`; the privacy level you
  chose must be one TikTok offers for the account, and the clip must fit the account's maximum
  length. Then it calls `video/init` with `FILE_UPLOAD` and sends the file in chunks to
  `upload_url` (whole up to 64 MB; otherwise 10 MB chunks, with the last chunk taking the remainder).
- **Published when:** `status/fetch` reports `PUBLISH_COMPLETE`. TikTok gives a link only for
  public posts that passed moderation; otherwise the publish id is kept as proof.
- **Note:** apps that haven't passed TikTok's audit can only post privately (`SELF_ONLY`).

## Performance numbers

Numbers come from the platforms (YouTube statistics, X `public_metrics`, TikTok `video/query`).
They're read every 6 hours for 30 days after publishing. Nothing is estimated or invented. A
private TikTok post has no public id, so it has no numbers.

## What has been verified

Everything above was tested against fake servers that follow each platform's documented requests
and responses. **None of it has been tested with real accounts yet.** See IMPLEMENTATION_STATUS.md.
