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

Apply an allocation change with:

```sh
docker compose up -d --build --force-recreate stream
```

This builds the current source, recreates the app with its selected limits, and starts it in the background. It briefly interrupts access but preserves configured media mounts and named data/cache/originals volumes. It does not delete files or allocate additional physical hardware.

## Optional NVIDIA recognition

If choosing GPU-backed object recognition, configure the host driver and NVIDIA Container Toolkit before enabling the GPU overlay. Keep any existing media/archive override in the same Compose file list:

```sh
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build stream
```

This adds GPU device access to the app, builds and starts/recreates it while retaining its selected storage. It cannot configure a Proxmox VM's PCI passthrough or an OS driver. The GPU-backed optional recognition stack is separate from normal viewing.

Docker Desktop's NVIDIA passthrough support applies to Windows with WSL2; it does not expose an Apple GPU to these Linux containers. This does not prevent the Mac from hosting a library or its browser from decoding video. VidStream no longer includes NCNN/RIFE/Real-ESRGAN enhancement runtimes or their GPU setup.

## Moving or adding machines

For an additional library, install the same app with fresh per-server state and connect it through Nodes. For a replacement server, stop the existing instance before moving its complete persistent state and source-media mapping. Do not share a live writable SQLite database between servers. See [Nodes](NODES.md) for direct library switching and [the README](../README.md) for mounts and backups.

## References

- [Docker Desktop resource settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources)
- [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/)
- [Compose GPU prerequisites](https://docs.docker.com/compose/how-tos/gpu-support/)
- [SQLite WAL restrictions](https://sqlite.org/wal.html)
