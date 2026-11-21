# VidStream hardware and container resources

VidStream serves media and creates viewing previews. Video upscaling and smoothing are no longer part of the application; prepare that media separately, then mount the finished folder. A GPU is not required to host or browse a library.

## What uses the hardware

- The browser decodes displayed videos. Preview limits, Data saver and device-local effects help control client load.
- The server reads media and generates thumbnails, posters and bounded previews. CPU and storage speed affect initial import; ongoing viewing mainly needs responsive storage and network bandwidth.
- Optional local recognition/OCR adds import work and can be disabled independently. General object recognition is off by default.
- Each server keeps its SQLite catalog and cache on its own local storage, even when source media is mounted from a NAS.

## Why the app can report 2 GiB

The Compose service sets its memory ceiling from `STREAM_MEM_LIMIT`, defaulting to `2g`; `memswap_limit` uses the same value. This describes a container limit, not installed physical RAM. The standard service sets no CPU quota. Docker Desktop or a VM can impose another CPU/RAM limit above the container.

Check the resource dashboard while importing or browsing. Increase resource allocation only when measurements justify it. On Docker Desktop, adjust its resource settings first and keep the container ceiling below the VM's allocation, leaving memory for the host and other apps. Set the chosen `STREAM_MEM_LIMIT` in the existing `.env`; this is a configuration setting, not a command.

Apply an allocation change to a manual Compose setup with this command.

```sh
docker compose -f docker-compose.yml up -d --force-recreate stream
```

This recreates the app with its selected limits and starts it in the background. It briefly interrupts access and reuses its mounts and data/cache/archive volumes. Include your existing local overrides in the file list. On a guided installation, open **Start-Here → Configure memory and access** to adjust RAM and extra swap. [Guided memory settings](STARTER.md#choose-memory-and-network-access)

## Optional NVIDIA recognition

If choosing GPU-backed object recognition, configure the host driver and NVIDIA Container Toolkit before enabling the GPU overlay. Keep any existing media/archive override in the same Compose file list:

```sh
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build stream
```

This adds GPU device access to the app, builds and starts/recreates it while retaining its selected storage. It cannot configure a Proxmox VM's PCI passthrough or an OS driver. The GPU-backed optional recognition stack is separate from normal viewing.

Docker Desktop's NVIDIA passthrough support applies to Windows with WSL2; it does not expose an Apple GPU to these Linux containers. This does not prevent the Mac from hosting a library or its browser from decoding video. VidStream no longer includes NCNN/RIFE/Real-ESRGAN enhancement runtimes or their GPU setup.

## Optional Intel Quick Sync for video encoding

Quick Sync uses an Intel graphics media engine. Check the exact CPU model,
graphics render device, and working FFmpeg encoder on the Linux host. A count
of 12 CPU threads describes CPU capacity. Quick Sync capability also depends
on the graphics hardware, driver, device permissions, and FFmpeg build.

```sh
lscpu
ls -l /dev/dri/
ffmpeg -hide_banner -encoders | grep h264_qsv
```

- `lscpu` prints the CPU model and logical CPU count.
- `ls` lists the GPU render nodes and permissions. A render node is typically
  called `renderD128`. Verify it belongs to Intel if there is more than one GPU.
- The FFmpeg command checks whether the installed binary exposes the H.264
  Quick Sync encoder. An encoder listing alone does not verify device access.

Run a real Quick Sync test as the account that will run VidStream. Change
the device path if your Intel GPU uses a different render node.

```sh
ffmpeg -hide_banner -v error -init_hw_device qsv=vidstream:hw,child_device=/dev/dri/renderD128 -f lavfi -i color=size=128x128:rate=24 -frames:v 4 -c:v h264_qsv -pix_fmt nv12 -f null -
```

This encodes four synthetic frames using Quick Sync and discards the
output. It reads no library files and writes no files. Success is silent.

For native hosting, set `VIDEO_ENCODER=qsv` and `QSV_DEVICE=/dev/dri/renderD128`
in the server environment. Install the Intel VA-API driver that supports your
GPU and give the account running VidStream access to its render node.
VidStream attempts a small hardware encode and falls back to software if the
device is unavailable or a specific encode fails. The server log reports
whether Quick Sync is available at the first encode. Quick Sync affects new
gallery preview encodes and compatible video copies that require an encode.
Existing derivatives remain reusable. Media
reads, remuxing, image work, hashing, and browser playback have their own costs.
[FFmpeg hardware device options](https://ffmpeg.org/ffmpeg.html) · [Intel Linux media driver](https://github.com/intel/media-driver)

On Linux Docker Engine, use the same render node in the container. For a
Start-Here installation that uses `vidstream-starter:local`, build the local
image with the optional Intel driver packages.

```sh
docker build --pull --build-arg INSTALL_INTEL_VIDEO_DRIVER=true -t vidstream-starter:local .
```

This refreshes the configured image base and builds the app and its optional
drivers into the image your existing starter configuration references.
Then merge these keys into the existing `stream` service and its existing
`environment` mapping in the generated `compose.yaml`. Use your actual Intel
render device on the host side of the device mapping.

```yaml
services:
  stream:
    devices:
      - "/dev/dri/renderD128:/dev/dri/renderD128:rw"
    environment:
      VIDEO_ENCODER: qsv
      QSV_DEVICE: /dev/dri/renderD128
```

Apply it using the same file and project you use for startup. Recreating
the current service reuses its media and volumes. For manual Compose, set
`STREAM_INTEL_VIDEO_DRIVER=true` in the private `.env` and add the same device
and environment keys through a local override before rebuilding. Your Intel
generation may need a driver newer than the packages in the image. Confirm
an actual encode on the host before enabling this path. [Compose service devices](https://docs.docker.com/reference/compose-file/services/#devices)

## Moving or adding machines

For an additional library, install the same app with fresh per-server state and connect it through Nodes. For a replacement server, stop the existing instance before moving its complete persistent state and source-media mapping. Keep each live SQLite database on its own host. See [Nodes](NODES.md) for direct library switching and the [command reference](COMMANDS.md) for mounts and backups.

## References

- [Docker Desktop resource settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources)
- [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/)
- [Compose GPU prerequisites](https://docs.docker.com/compose/how-tos/gpu-support/)
- [SQLite WAL restrictions](https://sqlite.org/wal.html)
