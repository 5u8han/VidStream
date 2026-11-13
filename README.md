# VidStream

**A self-hosted photo and video gallery for the files you already have.** Run
VidStream on your computer, NAS, or home server. Open it in a browser to
browse your folders, play videos, and share selected media with people
you trust. Your files stay on storage you control.

[Quick start](#quick-start) · [User guide](docs/USAGE.md) · [Requirements and commands](docs/COMMANDS.md) · [Docker Hub publishing](docs/DOCKER_HUB.md)

**Version 2.0** adds folder completion and guided access over SSH. Manual
Compose now publishes to localhost by default.

## What you can do

| Feature | How it works |
| --- | --- |
| Browse and play | A dense gallery with muted video previews, adjustable tiles, filters, and a responsive lightbox. Playback includes seeking, speed control, and optional statistics. |
| Organize several folders | Mount only the folders you want to serve. Switch between them in the top-left menu, with the first selected folder opening by default. |
| Keep track of media | Save favorites, pins, and bookmarks, resume playback, and review viewing history. The SQLite catalog retains these across container rebuilds. |
| Share with controls | Create an owner account, control guest visibility, and require sign-in when appropriate. Media mounts are read-only in guided setup. |
| Connect independent servers | Save the addresses of other VidStream installations and switch libraries from the top-center menu. Each server manages its own media, catalog, and sign-in. |
| Inspect and maintain | View storage and server resources, run catalog maintenance, and create catalog backups. Optional local recognition makes images and videos easier to find. |

## Quick start

You need a Docker host with Compose, access to at least one local media
folder, and a current browser. The launcher supports macOS, Linux, and
Windows with Linux containers.

From a terminal on macOS or Linux, run the following for a new checkout.

```sh
git clone https://github.com/5u8han/VidStream.git
cd VidStream
bash ./Start-Here.sh
```

- `git clone` downloads the source into a new `VidStream` directory.
- `cd VidStream` enters that directory.
- `bash ./Start-Here.sh` opens the guided setup. It creates a private
  `compose.yaml`, sets up Docker volumes, and starts the service after you
  select folders and a theme.

On Windows, open [Start-Here.bat](Start-Here.bat) from the downloaded checkout.
Choose **First-time setup**. Select the folder that should open first, add
any others, and choose a theme. Open the address the launcher prints, usually
`http://127.0.0.1:8080`. Enter its one-time setup code to create your owner
account. [Complete setup and update guide](docs/STARTER.md)

For an existing guided install, use **Add a media folder** to update its
private configuration. Apply the change with the launcher’s printed Compose
command. The container is recreated with its existing app volumes and the
new read-only media mount.

On a headless Linux server, run Start-Here in your SSH session and press
**Tab** to complete a folder path. Select the mounted directory that contains
the media. Then use an SSH port forward from your browsing machine to open
the gallery. [Headless and NAS setup](docs/STARTER.md#headless-linux-over-ssh)

## Choose a deployment

| Setup | When to use it | Guide |
| --- | --- | --- |
| Start-Here | One server, one or more folders, and guided Docker setup | [Start-Here](docs/STARTER.md) |
| Manual Compose | Explicit mounts, a NAS share, custom ports, or existing Docker storage | [Requirements and commands](docs/COMMANDS.md) · [Mounted folders](docs/MOUNTED_FOLDERS.md) |
| Independent servers | Switch between separate libraries on multiple machines | [Connect library nodes](docs/NODES.md) |
| Native Node.js | Run on the host using its media tools and resources | [Native setup](docs/COMMANDS.md#native-commands) · [Hardware](docs/HARDWARE.md) |

Start-Here publishes to the setup machine by default. For LAN access, use a
reachable host address and review sign-in and guest visibility before
sharing. Keep the generated Compose file, credentials, and media private.
[Security and privacy](SECURITY.md)

## Tech stack

- **Application:** Node.js with an embedded SQLite catalog and zero runtime
  npm dependencies.
- **Browser:** HTML, CSS, and JavaScript. Browser-native media controls and
  HTTP range requests support seeking. The gallery releases distant media
  elements as you scroll.
- **Media:** FFmpeg and FFprobe for video, ImageMagick and libheif for images,
  and ExifTool for metadata. Optional Python/OpenCV and Tesseract support
  local recognition and text search.
- **Deployment:** Docker Compose on Linux containers, with an optional
  native server. Media sources, catalog data, and preview cache have
  separate storage.

VidStream prepares previews and compatible playback copies. Prepare video
enhancements such as upscaling and frame interpolation in your own media
workflow, then mount the finished files.

## Guides

| I want to… | Read |
| --- | --- |
| Use the gallery, player, collections, dashboard, and sharing controls | [User guide](docs/USAGE.md) |
| Install, start, stop, update, back up, or test the app | [Requirements and commands](docs/COMMANDS.md) |
| Choose folder shortcuts or mount specific source directories | [Folder shortcuts](docs/FOLDERS.md) · [Mounted folders](docs/MOUNTED_FOLDERS.md) |
| Configure GPU access, a RAM cache, or connected servers | [Hardware](docs/HARDWARE.md) · [RAM cache](docs/RAM_CACHE.md) · [Nodes](docs/NODES.md) |
| Publish and verify the Docker Hub image | [Docker Hub publishing](docs/DOCKER_HUB.md) |
| Upgrade an older installation or review changes | [Storage migration](docs/BRANCHES.md#retain-existing-storage-before-rebuilding) · [Changelog](CHANGELOG.md) |

VidStream began as a video-first successor to
[photo-stream](https://github.com/waschinski/photo-stream). It is available
under the [MIT License](LICENSE).
