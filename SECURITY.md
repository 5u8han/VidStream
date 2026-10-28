# Security and privacy

Stream is self-hosted software; it can serve very personal media. **Do not upload your `.env`, cache, model settings, NAS credentials, or media files to GitHub.** A public repository should contain only source code and `.env.example`.

## Before allowing anyone outside your LAN

1. Complete owner setup with a long unique passphrase, or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` or configure LDAPS.
2. Set `REQUIRE_LOGIN=1` if every visitor must authenticate, and `ALLOW_INDEXING=0`.
3. Put Stream behind HTTPS and an access-aware reverse proxy. Avoid exposing the container port directly to the internet.
4. Never enable broad caching of personalized/private media via a CDN.
5. Back up the entire data and cache volumes, including security settings and SQLite. Original media is never automatically backed up by Stream.
6. Test signed-out sessions and shared albums before publishing any content.

Starting in 1.4, a server without credentials is locked behind owner setup. The one-time setup code is stored with owner-only file permissions and printed in the server log; it is never returned by a public API. Setup creates a salted scrypt password hash and a new session signing secret in the persistent data directory. Logout clears the session and no longer restores anonymous admin access. Existing environment-password and LDAP configuration remain supported. Settings can require sign-in for the entire library. Keep setup codes, persistent data and server logs private.

New dashboard, AI download, and rescan endpoints require admin authorization. The AI installer uses a fixed whitelist of model presets, not user-provided download URLs. GPU detection only shows devices visible to the server. Enhancement runtimes use pinned official archives with mandatory SHA-256 verification and extract only a fixed executable. Native Mac telemetry uses read-only IOKit/netstat without administrator access. Avoid mounting the Docker socket, root filesystem, or system logs into Stream.

Model weights and Ultralytics installations are third-party software. Assess their licenses for your use. The Stream code is MIT licensed; the AI packages and weights have separate terms. Read model software documentation before distributing combined images.

Older versions do not understand web-created owner credentials. Before rolling back below 1.4, configure `ADMIN_PASSWORD` and `REQUIRE_LOGIN=1`; do not assume the web-created lock survives a downgrade.

## Reporting

Report vulnerabilities privately to the repository maintainer. Do not publish exploitable details until users can update.
