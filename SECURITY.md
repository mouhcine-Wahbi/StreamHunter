# StreamHunter — Security & Privacy

## Principles

1. **No secrets in the extension.** Twitch/Kick client secrets and platform OAuth
   tokens only exist on the backend. The extension stores non-secret settings and,
   from Phase 2 on, a StreamHunter session token.
2. **Encrypted at rest.** Platform access/refresh tokens are encrypted with Fernet
   (`TOKEN_ENCRYPTION_KEY`) before being written to the database.
3. **No token logging.** Structured logs never contain tokens, auth headers or
   OAuth codes.
4. **Ownership checks.** Every resource query is scoped to the authenticated user
   in the service layer, so one user cannot read another user's data.
5. **Minimal data.** Raw chat messages are processed in memory and discarded. Only
   aggregated window statistics and detection events are stored, and they expire after
   the configured retention period.
6. **Explicit consent.** Monitoring status is always visible (badge, popup, side
   panel). Media capture, if added later, needs a user gesture and Chrome's
   permission prompt. Publishing always needs an explicit confirmation.
7. **Official APIs only.** No scraping, no unofficial chat sockets, no downloaders,
   no DRM or restriction bypasses.

## Extension specifics (implemented in Phase 1)

* Manifest V3 with the minimum permissions: `storage`, `alarms`, `sidePanel`.
* Host access only for `localhost:8000` / `127.0.0.1:8000`. A remote backend
  needs `https://` and an optional host permission that the user grants at runtime.
* Plain `http://` is rejected for any host other than localhost.
* Runtime messages are accepted only from this extension's own pages
  (`sender.id === chrome.runtime.id`) and validated against a fixed set of types.
* Requests use `credentials: "omit"`; authentication is an explicit bearer header.
* Navigation routes and outbound links are allow-listed (only `https:` clip URLs are rendered as links).
* No remote code, no `eval`, and the default MV3 content security policy.

## Backend specifics

Implemented in Phase 2:

* Passwords hashed with Argon2id (rehashed transparently when parameters change). Plaintext is never stored.
* Sessions are random 256-bit bearer tokens. Only their SHA-256 is stored, and they can be revoked (logout) and expire.
* Login gives the same response and similar timing for unknown accounts and wrong passwords.
* Register and login are rate-limited per client (in-process; use a shared store when running multiple instances).
* Every resource query is filtered by owner. Another user's record answers 404, exactly like a missing one.
* Logs are JSON with bearer tokens, OAuth codes, secrets and passwords redacted.
* In production, the backend refuses to start without `TOKEN_ENCRYPTION_KEY` or with SQLite.

Implemented in Phase 3:

* Platform OAuth: random `state`, stored only as a hash, single use, bound to user + platform, 10-minute expiry.
  Replayed, forged, cross-platform and expired callbacks are rejected. Kick uses PKCE (S256); the verifier is encrypted at rest.
* Platform tokens are stored Fernet-encrypted. Connecting is refused while `TOKEN_ENCRYPTION_KEY` is missing.
  Disconnecting revokes the tokens at the platform and deletes them.
* The OAuth callback page has no scripts (`Content-Security-Policy: default-src 'none'`), escapes all
  values, and is sent with `no-store` and `no-referrer`.
* The extension only opens authorization URLs on `id.twitch.tv` / `id.kick.com`.
* Platform error bodies are never echoed to clients; only status codes are logged.

Planned:

* Kick webhooks: RSA-SHA256 signature verification using Kick's published public
  key, timestamp freshness check, and deduplication by message ID.
* HTTPS required in production; CORS restricted to the extension origin.

## Reporting

Report vulnerabilities privately to the project owner. Do not open public issues for them.
