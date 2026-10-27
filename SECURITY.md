# Security and privacy

Stream is self-hosted software; it can serve very personal media. **Do not upload your `.env`, cache, model settings, NAS credentials, or media files to GitHub.** A public repository should contain only source code and `.env.example`.

## Before allowing anyone outside your LAN

1. Set `ADMIN_USERNAME` and a long unique `ADMIN_PASSWORD` (or configure LDAPS).
2. Set `REQUIRE_LOGIN=1` if every visitor must authenticate, and `ALLOW_INDEXING=0`.
3. Put Stream behind HTTPS and an access-aware reverse proxy. Avoid exposing the container port directly to the internet.
4. Never enable broad caching of personalized/private media via a CDN.
5. Back up the `.cache/index.json` if you have spent time marking files as guest-visible; original media is never automatically backed up by Stream.
6. Test signed-out sessions and shared albums before publishing any content.

Without configured authentication, Stream's existing compatibility behavior treats every visitor as an administrator. This is intended only for trusted local use. `REQUIRE_LOGIN=1` requires credentials to be configured.

New dashboard, AI download, and rescan endpoints require admin authorization. The AI installer uses a fixed whitelist of model presets, not user-provided download URLs. GPU detection only shows devices visible inside Docker. Avoid mounting the Docker socket, root filesystem, or system logs into Stream.

Model weights and Ultralytics installations are third-party software. Assess their licenses for your use. The Stream code is MIT licensed; the AI packages and weights have separate terms. Read model software documentation before distributing combined images.

## Reporting

Report vulnerabilities privately to the repository maintainer. Do not publish exploitable details until users can update.
