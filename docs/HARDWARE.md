# VidStream hardware allocation

VidStream can view media and run saved enhancement jobs. The browser (including iPad/iPhone) is the remote control and player; the machine running the server does the enhancement. Its web settings cannot increase a Docker/VM memory ceiling or attach hardware devices.

## Why the app reports 2 GiB

The supplied Compose service sets both `mem_limit` and `memswap_limit` from `STREAM_MEM_LIMIT`, defaulting to `2g`. This deliberately caps the container at 2 GiB with no additional swap allowance. It does not mean the physical computer has only 2 GiB. CPU counts come from the OS/VM, CPU affinity and any CPU quota; this project's standard Compose file sets no CPU quota.

Settings distinguish **OS / VM RAM**, **container RAM ceiling**, and effective RAM/CPU capacity. OS totals inside Docker Desktop or a Proxmox VM describe what that VM can see, not necessarily the entire physical computer. CPU capacity can be fractional when a quota allows less CPU time than the number of visible threads.

## Docker Desktop on a Mac

1. Open Docker Desktop → Settings → Resources → Advanced.
2. Increase its CPU and memory allocation, leaving sufficient resources for macOS and other applications. On a 36 GiB M3 Pro, a reasonable initial CPU-smoothing experiment is a 16 GiB Docker VM and a 12 GiB container ceiling; these are starting values, not model memory guarantees.
3. Apply the Docker Desktop changes. Edit the existing `.env` in your VidStream checkout to set `STREAM_MEM_LIMIT=12g` (or your chosen ceiling). This line is a configuration setting, not a terminal command. Keep the ceiling below the VM's available RAM and allow for other containers.
4. Recreate the service using the command below. Completed library data and enhancement checkpoints stay in their existing named volumes.

```sh
docker compose up -d --build --force-recreate stream
```

This command builds the current application, recreates only the `stream` service with the new resource setting, and starts it in the background. It does not delete named data/cache volumes or media. Existing jobs may pause during recreation and can resume from saved checkpoints.

More RAM/CPUs help CPU processing, but do not provide Apple GPU passthrough to VidStream's Linux-container NCNN tools. Docker Desktop's standard `--gpus` passthrough is documented for Windows/WSL2 NVIDIA devices; its separate Model Runner acceleration is not a passthrough mechanism for this app's RIFE/Real-ESRGAN executables. For the M3 Pro's Apple GPU, use VidStream natively on macOS with its native enhancement runtime. The README's native setup describes required tools. Keep the same data/cache paths if migrating existing saved jobs, stop the old instance before moving them, and keep a backup.

## Linux / Proxmox with NVIDIA

GPU access is an infrastructure setup step. The same VidStream app can then handle viewing and enhancements.

1. If using Proxmox, assign the GPU to the guest VM at the hypervisor layer and install a working NVIDIA driver inside the guest. Allocate VM CPU and RAM there too.
2. On the machine running Docker Engine, install/configure NVIDIA Container Toolkit. VidStream's NCNN upscaling tools also require working Vulkan GPU support; a successful `nvidia-smi` alone does not verify Vulkan inference.
3. Set a suitable `STREAM_MEM_LIMIT` in `.env`, allowing memory for both the host and other containers. Enable the supplied GPU Compose overlay using the command below.

```sh
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build stream
```

This command combines the normal service definition with the NVIDIA GPU overlay, builds the application, and starts/recreates `stream` in the background with GPU access. It retains the standard media mounts and named volumes. It requires the host driver/toolkit configuration to be complete; it cannot perform Proxmox PCI passthrough itself.

```sh
docker compose exec stream nvidia-smi
```

This diagnostic command runs NVIDIA's status utility inside the running service. It reports GPU visibility and memory; it does not start an enhancement job or change data. Use a short test enhancement afterward to verify the actual selected runtime/model.

## Practical choice

Keep Docker as the convenient gallery/CPU-processing deployment if that suits your hardware. For accelerated work, run this same project natively on the Mac or on a configured NVIDIA machine. Separate viewing-only software is not required, and model processing is opt-in. No simultaneous/multi-machine worker setup is introduced here.

## Sources

- [Docker Desktop resource allocation](https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources)
- [Docker Desktop GPU passthrough support](https://docs.docker.com/desktop/features/gpu/)
- [Compose GPU access and host prerequisites](https://docs.docker.com/compose/how-tos/gpu-support/)
- [NVIDIA Container Toolkit installation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
