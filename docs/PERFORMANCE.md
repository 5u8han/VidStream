# Large libraries and preview performance

VidStream uses three kinds of storage. The source media stays on its
read-only mount. The server's catalog and generated derivatives live on
persistent storage. The browser keeps a bounded working set of gallery
media for the current page.

## Scan a large library

Use **Folders → Scan** beside a mounted folder or collection. This scans that
folder and its descendants. **ⓘ** shows the saved scan time, outcome, file and
directory counts, supported media, and errors. The full-library scan discovers
mounted folders in parallel and interleaves their media during import.
If a scan is active, a manual folder request enters the queue. The current
operation, active paths, and time since the last progress appear in
**Dashboard → Scan activity**. Counts in the gallery summarize indexed items.
They are not a measurement of disk activity or remaining files.

There is no configured item limit at 100,000. Directory and file counters use
JavaScript safe integers. Practical limits include memory needed by the
catalog, cache disk space, file-system latency, and the time it takes to read
and encode source files. Metadata operations that do not return and source hashes with no read
progress time out after 45 seconds. A blocked system call may still need
the device or mount recovered on the host. Container block I/O alone may miss bind-mount reads.

`PROCESSING_CONCURRENCY=auto` sizes the media-processing queue from the
logical CPUs available to VidStream, including Docker CPU quotas, up to
64. The queue also budgets 384 MiB per worker after reserving 512 MiB for
the server. An explicit positive `PROCESSING_CONCURRENCY` value lowers
the resulting ceiling. **Settings → Library tools → Background work →
Process faster** uses the full budget. Balanced uses about half the
budget and Browse uses one background slot.

Set `SCAN_WORKER_MULTIPLIER=2` to try twice as many media-processing jobs
per CPU. Each node sizes its own queue. The doubled ceiling still depends
on memory and any explicit processing cap. New guided and manual Docker
deployments start with a 2 GiB memory limit, which permits four media
workers even on a 64-thread machine.

| Logical CPUs visible to VidStream | Default ceiling | Doubled ceiling | Memory budget needed to reach the doubled ceiling |
| ---: | ---: | ---: | ---: |
| 24 | 24 | 48 | 18.5 GiB |
| 32 | 32 | 64 | 24.5 GiB |
| 64 | 64 | 128 | 48.5 GiB |

These are queue slots. Preview encoding already requests two FFmpeg
encoder threads per video. Photo processing and recognition may launch
other child processes. RAM use also depends on the files and catalog
size. On workloads that already saturate CPU or disk, extra jobs can
take longer and affect playback.

The preparation and media-processing queues refill as jobs finish. One
slow file can occupy one worker without making the rest of its batch wait.
`SCAN_READ_CONCURRENCY=auto` allows up to four source preparation jobs.
Set `SCAN_READ_CONCURRENCY=8` to try eight on a fast SSD or several drives.
Explicit readers are limited to 64 and to twice the calculated media-worker
ceiling. Metadata checks use up to four times the reader limit, bounded
between 4 and 128. Directory discovery uses up to 32 of those slots.
A single DAS hard disk can slow down with too many simultaneous reads.
Node's asynchronous filesystem operations share its process-wide
`UV_THREADPOOL_SIZE` pool, configured when Node starts.

### Performance configuration for a larger host

For a 128 GiB server, this Compose example gives the container up to
96 GiB, enables the doubled media-worker ceiling and starts with eight
source preparation slots. Merge these keys into the existing guided
`compose.yaml` and retain its project name and storage mounts.

```yaml
services:
  stream:
    mem_limit: 96g
    memswap_limit: 96g
    environment:
      PROCESSING_CONCURRENCY: "auto"
      SCAN_WORKER_MULTIPLIER: "2"
      SCAN_READ_CONCURRENCY: "8"
      UV_THREADPOOL_SIZE: "16"
```

For manual Compose, put the same environment entries in `.env` using
`KEY=value` syntax and set `STREAM_MEM_LIMIT=96g` in place of the two
Compose memory keys. Recreate VidStream with your usual Compose
configuration to apply these values and reuse its database and cache.
Choose **Process faster** for bulk import. Compare Dashboard throughput,
playback and disk activity before raising read concurrency on a DAS.
VM resources and Docker CPU quotas can reduce the budget even with these
settings. [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)

### Estimate the SSD size

Use **Measure storage** after scanning a representative set of photos and
videos. The server returns cache and cache backing disk usage independently,
with logical and allocated bytes per cache directory. It also returns the
media counts and free bytes. For an initial estimate, scale photo thumbnail
and large-image storage by the expected photo count. Scale posters and
optimized video previews by the expected video count. Separately allow for
watched originals, compatibility copies, backups, the SQLite database and
free space during imports and upgrades. If you use the RAM snapshot cache,
allow room for two snapshot generations while it writes a new one. File
sizes vary with content and settings, so measure a sample that includes the
types and resolutions you actually collect.

## Find the slow stage

| What you see | What to check |
| --- | --- |
| The gallery takes a while to list items, even with previews paused | In **Check playback smoothness**, compare the catalog response time with the first visible thumbnail time. A slow catalog response points to server work such as SQLite queries or an import competing for resources. |
| Tiles appear quickly but preview clips wait | Check whether the files are still importing. If the clips are ready, inspect the browser Network timing for `/preview` or `/poster`. Those paths use generated assets. A slow response there can come from the cache disk, server load, or the connection. |
| Clips start promptly but scrolling drops frames | Compare **4** or **8** simultaneous previews with **64** on the same folder. Try **View → Video previews → Lightweight gallery**, which uses smaller existing posters and thumbnails and reduces effects while keeping previews active. Simultaneous decoders and compositing run on the viewing device. |
| Full playback is slow, but optimized previews are quick | Inspect **Stats for nerds** for buffering and playback source. The original may be waiting on the DAS, or the host may be preparing a compatible copy. |

Netflix describes a pipeline that prepares multiple encodes ahead of playback
and puts frequently viewed content close to clients through Open Connect. The
equivalent for this local library is to generate small previews in advance,
store them on the server's SSD, and let the browsing device decode only the
nearby videos. The DAS then handles initial import and full original playback.
Adaptive bitrate is useful for a single stream on an unstable link. Dense
gallery performance still depends on the total number of active videos.
[Netflix encoding](https://netflixtechblog.com/optimized-shot-based-encodes-now-streaming-4b9464204830) · [Netflix Open Connect](https://openconnect.netflix.com/Open-Connect-Overview.pdf)

## Set up the server

For a large DAS library, keep `/app/data` and `/app/.cache` on a local SSD.
The first contains SQLite, accounts, and viewing history. The second
contains posters, thumbnails, optimized video previews, and compatible
playback copies. Keep the same Compose project, volume names, and media
mount targets across updates. A regular restart or recreation reuses these
volumes. Deleting the volumes forces a fresh import and removes saved state.
Place the live SQLite file on local storage. [Docker volumes](https://docs.docker.com/engine/storage/volumes/) · [SQLite WAL](https://sqlite.org/wal.html)

Choose **Optimized** under **View → Video previews**. A video stays
on its poster while its optimized preview is pending. Visible videos pick up
newly ready previews during an import. **Original** previews
read the source file over the media mount. The simultaneous preview setting
is a ceiling for eligible visible videos. Thumbnails, posters, offscreen
tiles, and clips that are still being prepared do not count toward it.

During a large import, open **Settings → Library tools → Background work**
and choose **Browse comfortably** if you want browsing to take priority.
A 16 GB server can still have a 2 GiB VidStream container limit. See
[hardware settings](HARDWARE.md) for how to read and adjust that limit.
If you use recognition only occasionally, disable unused analysis options
before importing new folders. The CPU can then spend more time on previews.

Startup normally checks the mounted library for changes. Completed items
reuse their catalog records and derivatives. New or changed files can still
require a full read to establish content identity. After discovery and file checks, import interleaves selected mounts. Image
sizes within one stage come from a single decode, and background jobs free
their processing slots as soon as that stage completes.

After the initial import is complete, set `SCAN_ON_START: "0"` under
`services → stream → environment` in the generated `compose.yaml` if you
prefer to open the saved catalog on restart without an immediate scan.
With manual Compose, set `SCAN_ON_START=0` in `.env`. VidStream still scans
an empty catalog, a library with no completed scan under this version, or
a library whose mount or processing configuration changed. File watching
and configured interval scans are independent. To avoid a recursive watcher
traversal at startup, also set `WATCH_FOR_CHANGES: "0"` in guided Compose
and leave `RESCAN_INTERVAL_MINUTES` at zero. Use `WATCH_FOR_CHANGES=0` in a
manual `.env`. If your storage does not send reliable change notifications,
use the gallery's **Rescan library** control after adding files. Applying
this setting requires a container recreation using the usual Compose files.
An individual unreadable file can be retried with a manual rescan.

The optional RAM cache needs space for its entire working set and a disk
snapshot. Use a persistent SSD cache for a large library whose derivatives
can exceed the available RAM. [RAM cache options](RAM_CACHE.md)

## Check the current deployment

Run these read-only checks on the Linux host, from the directory containing
the active Compose file. Include the same Compose files and project flag you
use for startup.

```sh
docker compose stats --no-stream stream
docker compose logs --tail 50 stream
lsblk -o NAME,SIZE,ROTA,TRAN,MOUNTPOINTS
```

- `docker compose stats` samples CPU, memory, network, and block I/O for the
  app once. It leaves the container running.
- `docker compose logs` shows recent scan progress and errors. Logs may
  contain private paths.
- `lsblk` lists host disks, transport type, and mount points. Use it to
  distinguish the DAS source from the disk carrying Docker data.

On the browsing machine, use the Network tab in browser developer tools
while scrolling away and back. Requests ending in `/poster`, `/thumb`, or
`/preview` use generated server files. Requests for `/original` read the
source. Keep the same hostname throughout the check. Test with browser
cache settings left at their defaults. Compare a small, fully processed
folder during and after import to distinguish initial processing from
ordinary browsing.

The browser can freeze or discard an inactive tab under memory pressure.
A recent area can stay warm while the page is alive. A discarded page
loads again from the server's persistent catalog and preview cache.
[Browser page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

## Run work on another machine

The browser decodes playback. VidStream's host creates thumbnails,
previews, and playback compatibility copies. A second computer can
process independent sets of files as a separate offline job. Stage those
files on local storage if possible. Concurrently reading the same DAS from
two machines can increase contention, especially during a full audit.
Keep each live VidStream database and cache with its own server.

For browser-compatible copies, use MP4 with H.264 and AAC and front-loaded
MP4 metadata. Keep the original HDR, alternate audio, and subtitle tracks.
Transport-stream files are one HLS segment format. Evaluate HLS if adaptive
bitrate on a fluctuating network becomes a specific requirement.
[FFmpeg container formats](https://ffmpeg.org/ffmpeg-formats.html) · [Apple HLS](https://developer.apple.com/documentation/http-live-streaming/deploying-a-basic-http-live-streaming-hls-stream)

Use the [standalone media audit](MEDIA_AUDIT.md) to check for decode errors
in source files outside the app. Start with a sample folder before committing
to a full-library read.

## Persistent cache and playback resume

Docker's `stream-cache` volume holds generated thumbnails, posters, short
preview clips, and compatible playback copies on the machine running
VidStream. Give it SSD space and keep the same named volume on upgrades.
Ordinary startup and container recreation can reuse those files. The app
serves cached previews from this volume even though full playback can read
from the attached storage. If a browser drops a tile, it can fetch the
generated file again without another source read or encode.

`CACHE_MAX_BYTES` defaults to `0`, which keeps all generated files until the
cache is explicitly removed. If space is limited, set a byte limit for
**short video previews and compatible playback copies**. For example,
`107374182400` is 100 GiB. Use the existing `.env` with manual Compose, or
add `CACHE_MAX_BYTES: "107374182400"` under
`services → stream → environment` in your guided `compose.yaml`. Apply it
with the usual service recreation. [Update commands](COMMANDS.md#update-and-verify-the-existing-installation)

Once a minute, the app checks that budget and removes the oldest unused
eligible files. It leaves active media streams, recently used files,
thumbnails, posters, images, and recognition weights intact. Disk usage can
briefly exceed the budget while files are being used or generated. A
requested missing preview can be rebuilt from its original. The scanner
does not rebuild intentionally evictable previews on every regular scan.
The limit is inactive when the optional RAM snapshot cache is configured.
**Storage** shows the entire cache volume usage and the separate video
retention budget.

The `stream-data` volume holds accounts, catalog entries, preferences, and
the most recent playback position for each video. Positions are saved
during playback and on pause, seek, and close, independently of whether
optional viewing history is enabled. Reopening the same source resumes in
the player. Finishing a video resets its position. This data persists
across container recreation and travels with the library database backup.
The browser temporarily queues an unsent timestamp during a disconnect.
It removes that pending timestamp when the server acknowledges it.
