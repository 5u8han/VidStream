# VidStream

Downloadable, self-hosted software for browsing and sharing photos and videos that live on your own machines. It uses an embedded SQLite catalog, native browser playback and a small plain JavaScript frontend. There is no central VidStream cloud or upload service.

**Main 1.11.0** adds manually chosen folder shortcuts within one server, bounded nearby gallery contents and an optional RAM preview cache with shutdown snapshots. Independent library switching remains available. **main is the only branch**; the former branch names have been retired without deleting their merged history.

## Browse first

- Dense, zero-gutter media layouts, with one media-size control, whole-frame/cropped viewing and optional fine artist borders.
- Choose named, nested folder collections from the top-left title menu without rescanning or separate sign-ins. See [Folders](docs/FOLDERS.md).
- Distant tile contents are released as you scroll, keeping nearby images, controls and video decoders bounded while preserving scroll geometry.
- Muted previews capped at the original frame rate, up to 60 fps; offscreen video sources are released and preview concurrency stays bounded.
- Individual video enlargement and randomized larger previews remain available.
- Settings opens directly onto everyday appearance and player controls. View options shows layout, size and sorting directly; secondary tools stay under clearly labeled disclosures.
- Browser-local effects, viewer blur and playback statistics; reduced-motion preferences are respected.
- Favorites, pins, bookmarks, recent views, continued playback and per-item history persist independently of the source checkout.
- Native video controls, seeking through HTTP range requests, playback speed and optional Stats for nerds. The centered player still fits within 90% of the browser.
- Resource dashboard, library treemap, optional local object/text detection, catalog backups and conservative relinking.
- Independent libraries can be selected from the top-center switcher. Each server keeps its own media, accounts, history and database. See [Nodes](docs/NODES.md).

## Media preparation belongs outside VidStream

Video upscaling, frame interpolation/smoothing, enhancement model downloads, processing jobs, comparisons and clean-library exports have been removed. Existing jobs do not run after updating. Existing media, old result files, archives and stored records are preserved; the app does not delete them during this change. Prepare media separately, for example in ComfyUI, and mount the finished folder in VidStream.

The app still makes lightweight gallery previews and thumbnails and can prepare a browser-compatible playback copy when required. Those support viewing; they do not upscale or interpolate your collection. Optional recognition tags help search and are separate from media enhancement. Quick edit remains an explicit source-writing action, requiring a writable media mount.

## Quick start with Docker

Install Git and Docker on the machine that will serve the library. For a **new checkout**, these commands download official main, enter its folder and create a private configuration file:

```sh
git clone --branch main https://github.com/5u8han/VidStream.git
cd VidStream
cp .env.example .env
```

`git clone` downloads source, not personal media or another server's state. `cd` changes the terminal's current folder. `cp` creates `.env` from defaults and would overwrite an existing `.env`, so do not use it over an existing configuration.

Keep your media wherever it already lives. Set `STREAM_MEDIA_PATH` in `.env` to that existing absolute folder and `URL` to your server's reachable address. These are configuration values, not terminal commands. Uncomment the media-bind example under `stream.volumes` in `docker-compose.yml`; its target stays `/media/original`. An existing private Compose override may supply the mount instead, avoiding edits to the tracked base file.

The example is read-only and refuses nonexistent source paths. It permits viewing; Quick edit requires deliberately enabling writes. No media directory structure is included in the repository. With no media mount, the app starts with an empty library.

Build and start only the application in the background:

```sh
docker compose up -d --build stream
```

This builds the selected source and starts/recreates the app using your configured mounts. It retains named data/cache/originals volumes and does not move or delete media. On a first installation, it creates the application's own persistent volumes.

Open `http://localhost/` on that server or its reachable LAN address from another device. New installations require owner setup. Read its private one-time setup code from the startup log:

```sh
docker compose logs stream
```

This reads logs without changing data. Keep the setup code private, then choose an owner username and passphrase in the browser. Existing installations keep their configured account or LDAP sign-in. Sign out returns to the sign-in screen.

## Ports and hostnames

Docker publishes standard HTTP port **80** to internal port **4000**. Set `STREAM_HTTP_PORT=8080` if another service occupies 80; recreate the app and use the selected port in its public URL. `PORT` remains the native-run setting; the ordinary Docker service fixes its internal port at 4000.

`http://submac/` works only if that name resolves on the viewer's LAN. On a Mac, `http://submac.local/` is often the usable Bonjour address. Docker port publishing does not register DNS names. Port **443 requires real HTTPS**, usually a TLS reverse proxy and valid certificate; plaintext HTTP mapped to 443 does not enable it.

Align `URL`, Settings → Nodes → This library address and saved peer addresses when changing the public address. Saved node settings take precedence over environment defaults. See [node deployment details](docs/NODES.md).

A stable container path keeps host paths out of normal app settings. Docker/host administrators can still inspect mounts, and a compromised app can read mounted files. Read-only mounts prevent source writes; they do not hide the mounted collection. [Docker bind-mount behavior](https://docs.docker.com/engine/storage/bind-mounts/)

## Update an existing installation

Keep the existing `.env`, Compose project name, storage overrides and persistent volumes. In particular, retain an older host-bound `/app/originals` archive until deliberately migrated. The 1.9 base-file transition removed implicit host media/originals bindings; read [storage upgrade guidance](docs/BRANCHES.md#retain-existing-storage-before-rebuilding) if applicable.

```sh
git fetch origin
git switch main
git pull --ff-only origin main
docker compose up -d --build stream
```

- `git fetch origin` downloads remote history without changing working files, media, configuration or Docker data.
- `git switch main` selects official main and updates tracked source; it refuses conflicting local edits and preserves ignored personal data.
- `git pull --ff-only origin main` updates source only when no merge is needed. It does not discard local work or delete mounted media.
- `docker compose up -d --build stream` rebuilds/recreates the application with the selected mounts and existing persistent volumes. It briefly interrupts access, then starts in the background. It does not delete data.

Reload the browser after the rebuild. An already-open page keeps its older JavaScript until reloaded. Verify the running service without changing files:

```sh
docker compose exec stream node -p "require('./package.json').version"
```

This prints the container's package version; expect **1.11.0**. The source checkout, running container and loaded browser page are separate states.

Updating preserves historical enhancement records and files but removes their processing/control API and UI. Previously published files remain ordinary source media; an old active-variant choice no longer substitutes a separate enhancement job for the source. No model or job installation is necessary to browse.

## Persistent data and backups

| Storage | Purpose |
| --- | --- |
| Your explicit `/media/original` mount | Photos/videos you choose to serve |
| `stream-data` at `/app/data` | Catalog, permanent identities, history, accounts, settings and backups |
| `stream-cache` at `/app/.cache` | Rebuildable thumbnails, previews and optional recognition weights; optional RAM-mode snapshots |
| `stream-originals` at `/app/originals` | Preserved original archives from earlier releases; retain an existing host bind when upgrading |

Stop the app before copying its complete persistent state, then restart it after the copy. Back up media separately as well; a catalog snapshot does not contain the media itself. Session keys now live in persistent data; existing cache keys migrate without invalidating sessions. A preview cache can be rebuilt, but downloaded recognition weights are worth preserving. Keep the live SQLite database on the server's local storage, not a shared writable SMB/NFS database. Never remove volumes to fix a sign-in or missing-mount issue. [SQLite WAL limitations](https://sqlite.org/wal.html)

Optional [RAM cache mode](docs/RAM_CACHE.md) restores a saved cache into a bounded temporary memory filesystem before startup and saves it to the cache volume after a graceful stop. Default disk-cache behavior is unchanged. Cache-only cold starts are available without deleting the database or media. Forced termination and power loss cannot save new RAM-only work.

Quick edit saves originals and revision metadata in a hidden `.vidstream-originals` directory beside the source; preserve it when backing up a writable collection. Hidden archives are excluded from the gallery scanner.

Move one existing library by stopping it and transferring its complete state to the replacement host. Create a new independent library with fresh state; copying an existing node's database/session secret also copies its identity. Do not run both copies of one identity simultaneously.

## NAS, hardware and optional recognition

Run Docker directly on a NAS and bind its existing shared folder, or use the supplied read-only SMB overlay from another Linux Docker host. Configure the SMB fields in `.env` first:

```sh
docker compose -f docker-compose.yml -f docker-compose.smb.yml up -d --build stream
```

This combines the base app and SMB source mount, builds/starts the app and retains data/cache/archive storage. Include any existing private storage override in the same file list. It does not copy your library into the checkout or write to the SMB source. The Docker host needs CIFS mounting support; use a dedicated read-only share account. Change notifications do not cross SMB reliably, so the overlay polls for changes.

Settings and the dashboard report resources visible to the server/container. A default 2 GiB container ceiling does not describe the host's installed RAM. See [hardware allocation](docs/HARDWARE.md). iPhones/iPads and other browsers are viewing clients and do not need server model downloads.

Optional face/pet presence, OCR, perceptual duplicate grouping and object recognition run locally to organize/search the library. Disable them individually in `.env` if they add unwanted import work. General object detection is off by default; its optional Python stack and explicit model downloads are separate from the removed video-enhancement feature. The dashboard's recognition controls do not modify source media.

## Native operation

Use Node.js 22.13+, FFmpeg/FFprobe, ImageMagick and ExifTool. Python/OpenCV/Tesseract support optional detection and degrade gracefully when absent. Set `MEDIA_DIR` to an existing folder and choose persistent local `DATA_DIR`, `CACHE_DIR` and `ORIGINALS_DIR`; native `PORT` defaults to 4000. Then start the app:

```sh
node server.js
```

This starts VidStream in the foreground using your local configuration. It scans the chosen folder and writes catalog/previews into the configured state folders; the recommended read-only Docker mount is a separate deployment choice.

The optional native launcher provides a local configuration/start window. It is a convenience launcher for the same app, not a packaged media-processing product.

## Validation

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:compose
npm run test:browser
npm run test:nodes
```

- `npm ci --ignore-scripts` installs pinned development/test dependencies and replaces an existing `node_modules`; it does not change media, configuration or Docker volumes.
- `npm run check` checks JavaScript syntax without starting the app.
- `npm test` runs unit/integration checks using temporary fixtures.
- `npm run test:compose` resolves generated Compose configurations without starting containers or reading personal configuration.
- `npm run test:browser` runs generated-media Chromium checks for settings/options, player, previews and first-visit behavior.
- `npm run test:nodes` runs isolated multi-server browser checks for direct switching and independent sign-in/data. Both browser suites stop their own servers and delete only their temporary fixtures.

Browser checks need the Playwright Chromium engine and local media tools. Physical device frame rate and NAS throughput remain deployment measurements; same-host tests do not establish multicast behavior between real machines.

## Project history and license

VidStream began as a lightweight successor to [photo-stream](https://github.com/waschinski/photo-stream), adding video-first browsing and a durable local catalog. Earlier design and development checkpoints are described in [design behavior](docs/DESIGN_TEST_1.md), [catalog migration history](docs/DEV_TEST_1.md) and [the changelog](CHANGELOG.md). Historical enhancement instructions describe retired releases, not current features.

MIT; see [LICENSE](LICENSE).
