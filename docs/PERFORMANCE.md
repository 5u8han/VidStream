# Large libraries and preview performance

VidStream uses three kinds of storage. The source media stays on its
read-only mount. The server's catalog and generated derivatives live on
persistent storage. The browser keeps a bounded working set of gallery
media for the current page.

## Find the slow stage

| What you see | What to check |
| --- | --- |
| The gallery takes a while to list items, even with previews paused | In **Check playback smoothness**, compare the catalog response time with the first visible thumbnail time. A slow catalog response points to server work such as SQLite queries or an import competing for resources. |
| Tiles appear quickly but preview clips wait | Check whether the files are still importing. If the clips are ready, inspect the browser Network timing for `/preview` or `/poster`. Those paths use generated assets. A slow response there can come from the cache disk, server load, or the connection. |
| Clips start promptly but scrolling drops frames | Compare **4** or **8** simultaneous previews with **64**, leaving the same page and network in use. Simultaneous decoders and compositing run on the viewing device. |
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

Choose **Optimized** under **View → More controls → Playback**. A video stays
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
require a full read to establish content identity. After discovery and basic
file checks, import processes small batches across selected mounts. Previews
finish as each batch is processed.

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
