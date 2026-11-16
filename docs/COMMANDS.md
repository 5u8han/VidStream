# Requirements and commands

## Choose how to run VidStream

| Mode | Requirements |
| --- | --- |
| Docker on macOS or Windows | A current Docker Desktop installation running Linux containers, plus a checkout or extracted source archive. The host must give Docker access to the selected folders. Windows Start-Here uses PowerShell. [Docker Desktop](https://docs.docker.com/desktop/) |
| Docker on Linux or a NAS | Docker Engine, the Compose plugin and a host that can read the media. Use an amd64 or arm64 Linux container. Start-Here offers an automatic Docker Engine installation on supported Debian and Ubuntu systems with systemd. [Docker Engine](https://docs.docker.com/engine/install/) · [Compose installation](https://docs.docker.com/compose/install/) |
| Run natively | A supported Node.js LTS version that meets the `engines` entry in [package.json](../package.json), plus FFmpeg, FFprobe, ImageMagick 7 (`magick`) and ExifTool on the executable path. Node.js 24 LTS is recommended. ImageMagick 6 (`convert`) is also supported. Install `ldapwhoami` if configuring LDAP. For optional detection, install Python 3 with OpenCV and NumPy, and Tesseract with the desired language data for OCR. [Node.js release schedule](https://nodejs.org/en/about/previous-releases) |

Use a current browser. Video codec support varies by browser and device. Basic hosting needs no GPU. Allow space for the media and a local, writable disk for SQLite and generated previews. Import load and derivative size depend on the collection and enabled recognition. See [hardware and resource settings](HARDWARE.md).

Install Git only if you use the clone and pull commands. The Docker image already includes Node.js and the standard media tools. A source build or image pull needs internet access. Once the application and any optional weights are present, you can browse a locally available library without a Docker Hub account.

## Get the source and start

For a new checkout, clone the repository and enter it.

```sh
git clone --branch main https://github.com/5u8han/VidStream.git
cd VidStream
```

- `git clone` downloads the application source to a new `VidStream` directory. It needs an unused destination and leaves media and Docker state in place.
- `cd VidStream` changes the current terminal directory.

On macOS or Linux, run the launcher in that checkout. On Windows, double-click `Start-Here.bat`.

```sh
bash ./Start-Here.sh
```

This opens the guided menu. **First-time setup** writes a Git-ignored `compose.yaml`, creates the starter project's private host directories and starts the service with read-only media mounts. **Add a media folder** writes one additional mount and prints the command to apply it. Supply `--terminal` to enter folder paths without a picker. Supply `--help` to list the Bash launcher's options. [Start-Here guide](STARTER.md)

For manual Docker setup, copy `.env.example` to a new `.env` and set `URL` to the browser-facing address. `STREAM_HTTP_PORT` selects the host port, which defaults to 80. Compose publishes to `127.0.0.1` by default. Set `STREAM_HTTP_BIND` to the host's intended LAN interface address if clients should connect directly. Follow [mounted folders](MOUNTED_FOLDERS.md) to give Docker access to the selected media. Existing manual installs that relied on an all-interface listener must explicitly choose their bind address when upgrading. [Headless and NAS setup](STARTER.md#headless-linux-over-ssh)

```sh
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d --build --wait stream
docker compose -f docker-compose.yml logs --tail 100 stream
```

- `config --quiet` checks the Compose model without starting services.
- `up -d --build --wait stream` builds the app, starts or recreates the service in the background and waits for health. It uses the configured mounts and keeps existing named volumes. A recreation briefly interrupts playback.
- `logs --tail 100 stream` reads recent server logs. Keep them private because they can contain an owner setup code and local file paths.

## Compose files and persistent data

Compose commands must target the same project and file list you used to start the app. From a Start-Here checkout, plain `docker compose` selects the generated `compose.yaml` by default. The checked-in manual file is `docker-compose.yml`. Use the exact project and paths printed by the launcher if you have configured an override or keep the generated file elsewhere. An earlier starter installation can still use the file in your home directory. Preserve its `vidstream-starter` project name when moving the generated configuration. [Compose file selection](https://docs.docker.com/reference/cli/docker/compose/) · [Existing Start-Here installations](STARTER.md)

When using the manual setup, include `-f docker-compose.yml` and every existing overlay, in order, before the Compose action. Supply the existing `-p` project name if you started with one. A different project name can select new volumes and appear to have an empty catalog.

| Storage | Contents |
| --- | --- |
| `vidstream-local/{data,cache,originals}` | Default private host storage for new guided setups. [Portable storage and migration](PORTABLE_CACHE.md) |
| Host media bind or mounted share | Source photos and videos. Default example binds are read-only. |
| `stream-data` at `/app/data` | SQLite catalog, owner settings, account state, preferences, scan reports, playback positions and history. |
| `stream-cache` at `/app/.cache` | Rebuildable derivatives, compatibility copies and optional recognition weights. With the RAM overlay, this volume holds snapshots. |
| `stream-originals` at `/app/originals` | Retained archive volume. Preserve any existing override for this mount. Saved Quick edits keep their original beside the source in `.vidstream-originals`. |

## Operate and diagnose Docker

These examples use the generated Start-Here configuration. For manual Docker, use the same actions with the explicit file list from your installation.

| Command | Effect |
| --- | --- |
| `docker version` | Shows the Docker CLI and engine versions. If the daemon is unreachable, start Docker Desktop or your Linux Docker service. |
| `docker compose version` | Shows the installed Compose plugin version. |
| `docker context show` | Prints the active engine context. Start-Here expects a local Docker engine so its file selections refer to that host. |
| `docker compose config --quiet` | Validates the selected config. It does not start services or modify configuration. |
| `docker compose config --images stream` | Prints the image referenced by the selected service. This helps distinguish a local build from a registry image. |
| `docker compose ps -a stream` | Lists the service and its current status, including an existing stopped container. |
| `docker compose logs --tail 100 stream` | Reads recent logs, including any first-time owner setup code. |
| `docker compose logs -f stream` | Follows logs until Ctrl+C exits the log viewer. The app continues running. |
| `docker compose exec stream node -p "require('./package.json').version"` | Reads the version from the running container. |
| `docker compose up -d --pull never --wait stream` | Starts or updates the service using the local image and waits for health. It can recreate the container, keeping mounted storage. |
| `docker compose up -d --pull never --force-recreate --wait stream` | Recreates the starter service from its current image and configuration, including changed media mounts. It briefly interrupts playback and retains volumes. |
| `docker compose stop stream` | Stops the service and retains its container, image, volumes and configuration. It allows the configured graceful-stop time for RAM cache snapshots. |
| `docker compose restart stream` | Restarts the existing container with its existing mounts and settings. Use recreation to apply configuration changes. |
| `docker compose down` | Stops and removes the selected project's containers and network. It retains named volumes, images and saved configuration. |

A disposable test reset uses `docker compose down --rmi all --volumes`. It additionally removes the service image and deletes non-external project volumes. That can erase the catalog, account, history, previews and original archives stored in those volumes. Host media binds, external volumes and configuration files stay in place. Rebuild or pull the image before starting again. Use the [RAM cache cold-start procedure](RAM_CACHE.md#stop-restart-and-test-with-an-empty-cache) for a cache-only test. [Compose teardown options](https://docs.docker.com/reference/cli/docker/compose/down/)

## Update and verify the existing installation

```sh
git status --short
git pull --ff-only origin main
```

- `git status --short` shows uncommitted source changes. Check these before updating.
- `git pull --ff-only origin main` downloads and advances your checkout to the remote main branch when it can do so without creating a merge. Preserve your private configuration and resolve any conflicting local edits first. This updates source files without rebuilding Docker.

**If Start-Here references `vidstream-starter:local`**, build the current checkout and apply it to the existing service.

```sh
docker build --pull -t vidstream-starter:local .
docker compose up -d --pull never --wait stream
```

The build refreshes the configured base image and writes local image layers under the starter's tag. The second command applies the image and waits for health. It can briefly interrupt access and reuses the configured mounts and volumes.

**If Start-Here references a published image**, run `docker compose pull stream` to fetch that tag, then `docker compose up -d --pull never --wait stream` to apply it. A private image may require Docker Hub authentication. A commit-specific tag remains on that commit until you change the tag in the generated configuration. [Docker Hub guide](DOCKER_HUB.md)

**For a manual build**, run `docker compose -f docker-compose.yml up -d --build --wait stream` with your existing overlays. It rebuilds and applies the current checkout while reusing persistent state. Reload the gallery and verify the default folder, switching and video playback. See the [usage guide](USAGE.md).

## Optional Docker configuration

| Feature | Where to configure it |
| --- | --- |
| Several mounted folders | [Mounted folders](MOUNTED_FOLDERS.md) explains the example override, primary mount and apply commands. |
| Read-only NAS share | Bind a share already mounted on the host, or use `docker-compose.smb.yml` on a Linux host with CIFS support. Set `SMB_HOST`, `SMB_SHARE`, `SMB_USER` and `SMB_PASS` in the private `.env`. Use a read-only share account. |
| RAM cache | [RAM cache](RAM_CACHE.md) describes the overlay, memory limits, cold starts and graceful snapshots. |
| Local recognition on NVIDIA GPU | [Hardware](HARDWARE.md) covers the optional CUDA stack, driver and toolkit requirements and GPU overlay. Ordinary viewing works on CPU. |
| LAN discovery on Linux | [Nodes](NODES.md) covers manual connections, optional discovery and the host-network overlay. |
| Optional external access | The manual Compose file includes the opt-in `tunnel` profile for a separately configured Cloudflare Tunnel. Configure access controls, keep its token in private `.env` and check [security guidance](../SECURITY.md). |
| Your own remote media mount | The manual Compose file includes an opt-in `remote` profile for a separately configured rclone/FUSE setup on a compatible Linux host. Review the profile's device and privileges and provide its read-only mount to the app. A host-mounted read-only directory also works. |

For the SMB option with a manual base file, use the following after filling in `.env`. Keep any additional private overrides you already use.

```sh
docker compose -f docker-compose.yml -f docker-compose.smb.yml up -d --build --wait stream
```

This builds and starts or recreates the service with the read-only share. The configured data, cache and archive mounts remain available.

## Native commands

Configure `MEDIA_DIR`, `DATA_DIR`, `CACHE_DIR` and `ORIGINALS_DIR` in the shell or local `.env`. Choose an existing media directory and separate writable directories for state, cache and archives. Set `HOST=127.0.0.1` for access only from this machine. Set `PORT` if port 4000 is occupied.

| Command | Effect |
| --- | --- |
| `node server.js` or `npm start` | Starts the app in the foreground. It reads source media and writes catalog records and derivatives to configured storage. Ctrl+C stops it. |
| `npm run launcher` | Opens the optional local configuration/start window for native operation. Use it to select paths and start or stop the native server. |
| `python3 scripts/media-inventory.py "/path/to/media"` | Summarizes an existing media tree by depth, extension, sizes and largest subtrees. It reads directory entries and metadata and prints the report. Folder labels are anonymous by default. Adding `--show-folder-names` includes relative folder names. |

For a native test on Ubuntu, use a small mounted folder and separate SSD
directories for database and cache. From the checkout, replace the sample
source path and start a private instance.

```sh
HOST=127.0.0.1 PORT=4000 MEDIA_DIR="/mnt/das/sample" DATA_DIR="$HOME/vidstream-native/data" CACHE_DIR="$HOME/vidstream-native/cache" ORIGINALS_DIR="$HOME/vidstream-native/originals" node server.js
```

This runs the server in the foreground, on port 4000, with separate native
state. It reads the selected source during import and writes generated
files and the catalog under `$HOME/vidstream-native`. It creates or uses an
owner account in that state directory. Reach a headless instance through an
[SSH port forward](STARTER.md#headless-linux-over-ssh), using server port 4000.
A long-running installation can be managed by your operating system's service
manager. An existing HTTP reverse proxy can continue to serve a URL like
`http://subuntu/` by forwarding to this port.
Avoid running Docker and native VidStream against the same state directory.
To migrate an existing deployment, stop it and keep the same media-relative
paths as you copy its persisted state. See [Intel Quick Sync](HARDWARE.md#optional-intel-quick-sync-for-video-encoding)
for native and Docker device access.

## Release and deployment checks

| Command | Effect |
| --- | --- |
| `npm run check` | Checks JavaScript syntax without starting VidStream. |
| `bash -n Start-Here.sh` | Checks the Bash launcher's syntax without running setup. |
| `docker compose config --quiet` | Checks your Compose configuration. It starts no containers. |
| `docker compose ps stream` | Shows the running service and its health. |

After deploying, open your gallery, confirm the first library, switch folders,
and open and seek in a video. GitHub validation builds the Docker image and
checks startup health using temporary Docker resources.

See [the sample configuration](../.env.example) and
[security and privacy](../SECURITY.md) for deployment settings.
