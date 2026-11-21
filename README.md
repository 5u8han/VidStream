# VidStream

**Launch Edition · v3.1.0** is the first public launch of VidStream, a photo
and video gallery you run on your own machine. Pick a few folders from your
camera roll, NAS, or external drive. Open the gallery and muted clips are
already playing. For a two-hour video, you can skim five seconds from each
minute right in the grid.

[Get started](#get-started) · [How to use everything](docs/USAGE.md) · [Update an existing install](docs/STARTER.md#update-an-existing-installation) · [Troubleshooting](docs/USAGE.md#something-feels-off)

## The short version

- **Browse first.** A dense grid, live previews, adjustable tile sizes, and
  quick playback controls keep the media front and center.
- **Bring your folders.** Choose the directories you want to see in setup.
  Switch between them from the folder name at the top left.
- **Pick up where you left off.** Refresh your tab and return to the same
  folder, gallery position, or open media item. Video playback positions stay
  with the server catalog.
- **Give your storage a break.** Generated previews and recently viewed
  source ranges live on the host cache. Optional browser memory keeps clips
  nearby as you scroll back.
- **Make a large library manageable.** See scan progress, pause indexing,
  explore a folder storage map, and review failed files in a dedicated repair
  page.
- **Use the machines you have.** Run independent libraries on a NAS, desktop,
  or laptop and add them to a Server's Node switcher. Each machine owns its
  media, catalog, and sign-in.

Your original media lives on storage you choose. You download VidStream and
host it yourself. The browser connects to your installation.

## Get started

Have a media folder and a machine that can run Docker. The starter supports
macOS, Linux, and Windows using Linux containers. An SSD for the catalog and
cache makes a difference, especially when your originals live on an HDD,
DAS, or NAS.

For a new checkout on macOS or Linux, open a terminal and run these in order.

```sh
git clone https://github.com/5u8han/VidStream.git
cd VidStream
bash ./Start-Here.sh
```

1. `git clone` downloads the app into a new `VidStream` folder.
2. `cd VidStream` moves the terminal into that folder.
3. `bash ./Start-Here.sh` opens the setup menu. Choose **First-time setup**.
   It checks Docker, asks for folders, memory, network access, and a theme,
   then saves your configuration and starts VidStream. Media mounts are
   read-only.

On Windows, download or clone the repo and double-click
[Start-Here.bat](Start-Here.bat). On a server without a desktop, the starter
lets you type folder paths with Tab completion.

Open the address the starter prints. Use its one-time owner setup code,
choose a passphrase, and let the first import run. A good first check is to
open the folder name at the top left, pick another folder, and play one of
its videos. You can browse items as previews become ready. Choose LAN
access and port 80 if you want an address
like `http://subuntu.local/` from another device. That hostname needs to
resolve on your network.

On a new installation, the starter keeps its private `compose.yaml` and
`vidstream-local/` in the checkout. Keep both when updating.
[Step-by-step setup](docs/STARTER.md)

## Find your way around

| Control | What you get |
| --- | --- |
| **Folder name**, top left | Your chosen folders and their scan controls |
| **Node**, top center | Other saved VidStream machines |
| **View** | Tile size, sorting, filters, outlines, autoplay, and browser preview memory |
| **Settings** | Themes, player blur, scan schedules, library tools, and machine roles |
| **Dashboard** | Scan activity, resources, storage maps, benchmark, repairs, and logs |
| Any media tile | The full viewer, metadata, playback controls, and saved flags |

For a long video, use **Optimized** previews to skim its timeline. VidStream
plays the opening and then up to five seconds at 1:00, 2:00, and each following
minute. Later samples are generated as you watch and cached for next time.
The first uncached sample can take a moment to prepare.

Want to keep more ready clips? **View → Video previews → Browser preview
memory** offers up to 2 GiB per tab. New browsers start at 1 GiB. You can set
it to Off on any device. [Gallery and player guide](docs/USAGE.md)

## Keep your progress through updates

In a guided Git installation, open **Settings → Updates → Check for updates**.
Choose **Install update** if one is available. On the host, **Start-Here →
Update VidStream** does the check and applies an available update in one step.
Both compare the running build with GitHub's `main` commit. When you're
current, you can keep watching without a rebuild or restart.

Moving up from an older version? Start with the [one-time upgrade
steps](docs/STARTER.md#update-an-existing-installation). In-app installation
uses a small helper that Start-Here runs on the Docker host. After a host
reboot, choose **Start existing VidStream** to reconnect it.

The catalog, account, cache, and playback positions belong to persistent
storage. Keep the same Compose project and mounts when upgrading. A completed
catalog can reopen without walking the whole library. You decide when to
scan again in **Settings → Scan scheduling**. [Updates](docs/STARTER.md#update-an-existing-installation) · [Persistent storage](docs/PORTABLE_CACHE.md)

## A few things to know

- **The first import does real work.** Reading files, checking metadata, and
  creating previews for a huge library takes time. Dashboard shows what is
  running and lets you pause indexing.
- **Preview speed has several moving parts.** Storage, server encoding,
  network delivery, and browser decoding all matter. Run the built-in
  benchmark from the device you normally watch on.
- **The media mounts start read-only.** Saved crop or trim edits need write
  access and keep an original archive beside the source. Review that workflow
  before enabling it.
- **Repairs have limits.** A failed import can be retried and a compatible
  playback copy can be rebuilt. Missing source data needs recovery from an
  original, a backup, or a specialist tool.
- **Your installation has its own sign-in.** Each connected machine checks
  its own owner session. Keep the private configuration and catalog backed up.

[Performance guide](docs/PERFORMANCE.md) · [Repair and recovery](docs/MEDIA_AUDIT.md) · [Security and privacy](SECURITY.md)

## What runs underneath

| Layer | Tools |
| --- | --- |
| Server and catalog | Node.js, embedded SQLite, no runtime npm dependencies |
| Browser | HTML, CSS, JavaScript, native video playback, HTTP range requests |
| Media preparation | FFmpeg, FFprobe, ImageMagick, libheif, ExifTool |
| Optional search tags | Python, OpenCV, Tesseract, and the optional object-recognition stack |
| Deployment | Docker Compose with Linux amd64/arm64 support, or native Node.js |

Prepare upscaled or interpolated media in your own tools, then add the
finished files to a selected folder. VidStream handles gallery previews and
compatible playback copies.

## The guide shelf

| You want to… | Start here |
| --- | --- |
| Set up your first library or manage the launcher | [Start-Here](docs/STARTER.md) |
| Use each gallery, playback, and Dashboard feature | [User guide](docs/USAGE.md) |
| Find requirements, manual installs, and explained commands | [Command reference](docs/COMMANDS.md) |
| Choose folder mounts | [Mounted folders](docs/MOUNTED_FOLDERS.md) |
| Connect more machines | [Nodes](docs/NODES.md) |
| Tune a huge library | [Performance](docs/PERFORMANCE.md) |
| Compare servers and viewing devices | [Benchmark](docs/BENCHMARK.md) |
| Move your catalog and cache | [Portable storage](docs/PORTABLE_CACHE.md) |
| Try a server RAM cache | [RAM cache](docs/RAM_CACHE.md) |
| Enable hardware encoding or recognition | [Hardware](docs/HARDWARE.md) |
| Review media failures or export originals for recovery | [Media audit and repair](docs/MEDIA_AUDIT.md) |
| Check publishing or deployment details | [Docker Hub](docs/DOCKER_HUB.md) · [Security](SECURITY.md) |
| See what changed | [Changelog](CHANGELOG.md) |

VidStream began as a video-first successor to
[photo-stream](https://github.com/waschinski/photo-stream).
Available under the [MIT License](LICENSE).
