# Portable cache and migration

Start-Here keeps a new installation's private state beside its generated
`compose.yaml`, under `vidstream-local/`. Choose a checkout on the Docker
host's SSD. Git, Docker builds, and the media scanner exclude this directory.
Keep application storage outside the media folders.

| Path | Contents |
| --- | --- |
| `vidstream-local/data/` | Library database, hashed local passphrase and session secret, settings, node identity, favorites, viewing history and playback positions |
| `vidstream-local/cache/` | Ready thumbnails, posters, optimized video previews, compatible playback copies and viewed source ranges |
| `vidstream-local/originals/` | The app's configured archive volume |
| Your selected media folders | Source media and any originals archived beside the sources by editing or the audit |

The app writes generated files directly to the host cache while it runs.
Docker mounts the same directory the next time it starts, so there is no
bulk copy at startup or shutdown in disk mode. Frequently read files can
also be retained by the host operating system's RAM cache. Use Start-Here's
stop option before copying the directory so that pending work and SQLite
writes can settle.

The scanner saves catalog entries and completed derivative stages during
the import. After an interruption, the next scan can reuse that work for
unchanged source files. It walks the source directories again to check
what is there. Recent scan operations are saved with the scan report.
Manual Compose defaults to the `stream-data` and `stream-cache` Docker
volumes. The storage location follows your existing mounts. To use
`~/VidStreamCache`, explicitly bind a directory there to `/app/.cache`
and retain the current data mount for SQLite. Keep this folder on the SSD
and outside the source library.

An optimized preview can be fetched from the host cache even after a browser
drops its local copy. With **Original** preview mode or the full player,
uncached portions of a source still have to be read from the attached drive.
For long-video timelines, later clips are encoded one at a time as viewers
reach them. The opening preview and existing catalog can be reused across the
update. Timeline clips have their own retention target of 8 GiB on disk or
2 GiB in RAM snapshot mode. Set `VIDEO_TIMELINE_CACHE_MIB` to change this
target (up to 64 GiB). A smaller overall disk-cache limit or half of the
runtime tmpfs capacity can reduce the effective target.
VidStream remembers viewed source blocks on the host. It opens and checks the
source before reusing blocks, so the drive may still show metadata activity.
The cache stops adding viewed blocks when about 1 GiB of disk space remains.
Explicit downloads bypass this cache.
An import or rescan reads the source independently of playback. To distinguish
these, check **Dashboard → Scan activity** and compare the browser's network
requests for `/preview` and `/original`.

**View → Video previews → Browser preview memory** lets you choose Off,
256 MiB, 512 MiB, 1 GiB or 2 GiB for recent clips in the current tab.
This can avoid another LAN request when scrolling back. A previously
enabled memory cache and a new browser start at 1 GiB. An existing Off
choice stays off. The tab downloads a complete clip
when it fits, with up to 16 MiB per clip. Busy or slower transfers can use
ordinary streaming. Closing the tab releases these copies.

## Move to another host

1. In Start-Here, choose **Prepare storage to move**. For portable installations
   this stops VidStream. For a standard older guided install it also copies the
   Docker volumes to `vidstream-local/` and updates the saved Compose file. The
   old volumes and `vidstream-local/compose.before-portable.yaml` are retained.
   Wait for the launcher to report that it is ready to copy.
2. Copy `vidstream-local/` and the private `compose.yaml` to the destination
   checkout, preserving permissions and file timestamps. Copy `.env` or
   any local Compose overrides if your deployment uses them. Keep the app
   stopped while copying. On Linux, the directory may contain files owned
   by the container user and require administrator access to copy. On Windows,
   use a checkout in a private user directory so its inherited permissions
   protect the cache and passphrase data. Leave the host control mailbox
   (`.vidstream-updater/`), its locks and the host folder grants
   (`.vidstream-media-roots.json`) on the source. Start-Here creates a private
   mailbox at the destination even when Python is unavailable or Docker needs
   sudo. The gallery works in that mode. Use option 8 on the destination to
   grant any additional folders to its web picker when host controls are enabled.
3. Mount or move your original media separately. In the copied Compose file,
   adjust media bind **sources** to the new host paths. Keep the container
   paths and mount names unchanged so the transferred catalog and derivatives
   still match. Update the bind address and `URL` if the host address changed.
4. Build or pull the image the copied Compose file references. Choose **Start
   existing VidStream** in Start-Here. Check that your account, folders,
   previews and playback positions are present. A different source filesystem
   can invalidate cached blocks and trigger a new scan. Catalog records and
   derivatives for files with unchanged sizes and modification times can
   still be reused.

On a guided Git installation, the destination launcher also connects the
update helper for that host. Its private `.vidstream-updater/` holds pending
requests and status for the local Docker engine. Leave that directory on
the old machine when transferring the library.

## Manual Compose

For a fresh manual install, the [portable storage overlay](../docker-compose.portable.yml)
maps the same host directories. Create them and include the overlay in the
Compose file list. For an existing manual install, stop it and copy its
current app data, cache, and archive storage before applying the overlay.
Mounting a new empty directory will make the app start with empty state.

```sh
mkdir -p -m 700 ./vidstream-local
mkdir -p ./vidstream-local/data ./vidstream-local/cache ./vidstream-local/originals
docker compose -f docker-compose.yml -f docker-compose.portable.yml config --quiet
```

- The first command creates the local state directory with owner-only permissions
  when newly created.
- The second creates the three bind sources and keeps any existing files.
- The third validates the configured files and does not start Docker or write
  media. Include your usual media or hardware overlays in the same file list.

Docker's removal of named volumes does not delete host bind directories.
Treat the portable directory as private data. [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) · [Docker stop grace period](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)

## Optional RAM snapshot mode

If you already use the [RAM-cache overlay](RAM_CACHE.md), keep its named
snapshot volume or use the [portable RAM overlay](../docker-compose.portable-ram.yml)
after creating the portable directories. Apply it **after** your portable
Compose configuration and media overlays. It holds generated derivatives on
a bounded tmpfs while the app runs, saves a verified generation into
`vidstream-local/cache/.ram-cache/` on graceful shutdown, and restores
that generation on startup.

Allow enough RAM for the working set and enough SSD space and time for a
complete copy. A forced stop or power loss leaves only the previous completed
snapshot. A large cache is better suited to disk mode, which commits generated
assets as they are created.
