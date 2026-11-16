# Security and privacy

VidStream serves media from your own storage. Keep your `.env`, generated `compose.yaml`, cache, NAS credentials, database, and media out of public repositories. Use the example configuration files when sharing setup details.

## Before allowing anyone outside your LAN

1. Complete owner setup with a long unique passphrase, or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` or configure LDAPS.
2. Verify that a signed-out browser is redirected to sign-in when opening a library or media link.
3. Put Stream behind HTTPS and an access-aware reverse proxy. Avoid exposing the container port directly to the internet.
4. Never enable broad caching of personalized/private media via a CDN.
5. Back up the entire data and cache volumes, including security settings and SQLite. Original media is never automatically backed up by Stream.

Library pages, files, and downloads require owner sign-in. Local sign-in accepts the configured passphrase alone. LDAP deployments still use a username. Upgrades ignore previous guest visibility and sign-in switches. A server without credentials is locked behind owner setup. The one-time setup code is stored with owner-only file permissions and printed in the server log. Setup creates a salted scrypt password hash and a session signing secret in the persistent data directory. Existing environment-password and LDAP configuration remain supported. Keep setup codes, persistent data, and server logs private.

New dashboard, AI download, and rescan endpoints require admin authorization. The AI installer uses a fixed whitelist of model presets, not user-provided download URLs. GPU detection only shows devices visible to the server. Video enhancement runtimes, downloads and job APIs have been removed. Historical files are preserved, and no saved enhancement job is executed. Native Mac telemetry uses read-only IOKit/netstat without administrator access. Avoid mounting the Docker socket, root filesystem, or system logs into Stream.

Model weights and Ultralytics installations are third-party software. Assess their licenses for your use. The Stream code is MIT licensed; the AI packages and weights have separate terms. Read model software documentation before distributing combined images.

Use a patched Node.js LTS release for native hosting and update your Docker
image as application or base-image patches become available. The application
has zero runtime npm dependencies. The Docker image and optional recognition stack have
their own operating-system and Python packages. For registry publishing, use
a write-enabled token in GitHub Actions secrets and rotate it before it
expires. [Update commands](docs/COMMANDS.md) · [Docker Hub publishing](docs/DOCKER_HUB.md)

## Linux host access

Manual and guided bridge-network installs publish to `127.0.0.1` by default.
On Linux, use a current Docker Engine release. Versions older than 28 can
expose loopback-published ports to peers on the same Ethernet segment. For
direct LAN access, bind to the intended host address and check the host's
Docker-aware firewall rules. Docker can bypass ordinary UFW input rules when
it publishes ports. Start-Here reports relevant Docker settings and leaves
firewall rules to the host administrator. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) · [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

For an HTTPS reverse proxy, enable `TRUST_PROXY=1` only on a backend that the
trusted proxy controls. Preserve the request host and overwrite forwarded
headers at the proxy. Direct browser or SSH-forwarded HTTP can use the default
proxy setting. [SSH setup](docs/STARTER.md#headless-linux-over-ssh)

Older versions do not understand web-created owner credentials. Before rolling back below 1.4, configure `ADMIN_PASSWORD` and `REQUIRE_LOGIN=1`; do not assume the web-created lock survives a downgrade.

## Reporting

Report vulnerabilities privately to the repository maintainer. Do not publish exploitable details until users can update.
