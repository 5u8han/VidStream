# VidStream Start-Here

Get a VidStream checkout and open that folder. The starter configures a single
self-hosted instance. Docker reads your selected folders on your machine.

On macOS or Linux, open the launcher from the checkout.

```sh
bash ./Start-Here.sh
```

This opens the action menu. **First-time setup** checks Docker and starts the
local engine if needed. If Docker is missing on a supported system, it asks
before launching an administrator-approved install. It creates a local Compose
file and the private `vidstream-local/` directories for the starter project,
then starts VidStream with read-only media mounts.

Automatic Linux installation uses Docker's signed packages on Debian or Ubuntu
with systemd on x86-64 or ARM64. Other Linux distributions can run the helper
with an existing local Docker Engine and the Compose plugin. Use `--terminal`
with the Bash helper to enter folder paths. [Docker Engine installation](https://docs.docker.com/engine/install/)

On Windows, double-click `Start-Here.bat` in the checkout. It opens the same
menu in PowerShell and keeps the terminal open for the result. Docker Desktop
may ask you to accept its terms or finish installing WSL before first-time
setup can continue. Use a checkout in your own user directory so the host storage inherits private permissions. [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)

1. Choose **First-time setup** and pick the folder you want to see first.
   Answer Yes each time you want to add another library folder. Answer No
   or press Enter when the list is complete. Where a system folder picker is
   available, use it to select folders. Start-Here falls back to the terminal
   if the picker cannot open. Press **Tab** to complete paths.
2. Choose **White**, **Dark** or **System**. Press Enter for White. A theme you
   select later in VidStream takes precedence over this starting preference.
3. Open the address the helper displays, normally `http://127.0.0.1/`.
   Enter the owner setup code shown by the helper and choose a passphrase
   in the browser.

The helper saves a private `compose.yaml` beside Start-Here in the checkout.
Each machine generates its own file. Git and the Docker build context ignore
it because it contains local folder paths. From that checkout, Docker Compose
prefers `compose.yaml` and uses its `vidstream-starter` project name by default.
If you set `COMPOSE_FILE` or `COMPOSE_PROJECT_NAME` in the shell or `.env`, use
the explicit project and file in the command printed by Start-Here.

Start-Here still finds an earlier `VidStream-setup/compose.yaml` in your home
directory when the checkout has no `compose.yaml`. To manage that installation
from the checkout, copy the old file beside Start-Here as `compose.yaml` and
keep its `name: vidstream-starter`. Use the checkout copy for future edits.
The project name keeps it connected to the same Docker volumes. Keep custom
relative paths valid when moving the file. `VIDSTREAM_INSTALL_DIR` explicitly
selects a different directory.

The starter binds the published port to localhost. To serve viewers
on your LAN later, update the published address and `URL` deliberately in
that file. New guided installs keep the account, catalog and cache in `vidstream-local/`
beside the Compose file. Existing installs can move from Docker volumes using
Start-Here. [Portable storage and migration](PORTABLE_CACHE.md) [Docker bind mount reference](https://docs.docker.com/engine/storage/bind-mounts/)

If port 80 is in use or Docker cannot publish it, set `VIDSTREAM_PORT` before setup. An existing setup keeps its saved port. If the helper has
already created `compose.yaml`, adjust its published port and `URL` instead. The default is HTTP. For certificate-backed HTTPS on port 443, use the [local HTTPS overlay](NODES.md#optional-https-on-port-443).
From the checkout with the generated `compose.yaml`, you can check the
configuration, read the setup code or start again after fixing a path or port.

```sh
docker compose config --quiet
docker compose logs stream
docker compose up -d --pull never --wait stream
```

- `config --quiet` validates the selected Compose file without starting Docker
  services or changing files.
- `logs stream` reads the service logs, including the private owner setup code
  on a new installation. It does not change files or Docker data.
- `up -d --pull never --wait stream` starts or recreates the service with the
  local image and waits for it to be healthy. It reuses the configured data, cache and
  archive storage and mounts media read-only.

For a normal teardown, `docker compose down` stops and removes the container
and its network while retaining the image and volumes. For a disposable test
installation, `docker compose down --rmi all -v` also removes the service
image and deletes the account, catalog, history, cache and any archived
originals in the project's non-external named volumes. Host bind-mounted
files, including `vidstream-local/` on a portable setup, stay on disk. Rebuild
or pull the image before starting again.

## Stop, start, or prepare storage to move

**Start existing VidStream** reuses the saved Compose project and its local
image. **Stop VidStream** gives the service up to five minutes to finish an
orderly shutdown. **Prepare storage to move** stops the service and prints
the folder and private Compose file to copy. For a standard older guided
installation, the same option first copies its three named volumes to
`vidstream-local/`. It retains the old volumes and saves the old Compose
file for rollback. [Portable storage and migration](PORTABLE_CACHE.md)

## Test an update on your existing installation

Use your normal generated `compose.yaml`. If it uses `vidstream-starter:local`,
run these commands from the updated checkout.

```sh
docker build --pull -t vidstream-starter:local .
docker compose up -d --pull never --wait stream
```

The first command refreshes the configured base image and builds the current
checkout as the local image referenced by the starter. It writes Docker image
layers. The second applies the image and
waits for VidStream to be healthy. It can briefly interrupt playback and
reuses the existing configuration and volumes. Check the first library, the
folder dropdown, and playback in the browser. Automated checks use generated
media and temporary configurations.

## Add a folder to an existing setup

With your local Docker engine running, open Start-Here and choose **Add a
media folder**. This option edits the `compose.yaml` created by Start-Here and
uses the VidStream image already on your machine. Select one folder. The
launcher validates the edit and saves a new read-only mount. The original
primary folder still opens after sign-in. When you are ready to apply the
new mount, run the command printed by the launcher. It recreates only the
VidStream service with the added mount. Playback briefly stops during
recreation. Compose reuses the local image and named volumes, and the media
mounts stay read-only. The folder appears in the dropdown when the service
starts.

## Headless Linux over SSH

1. Connect to the Linux server over SSH. Mount the NAS share on Linux first.
   Its Ethernet link-local IP can carry the NAS connection. VidStream takes
   the mount directory, such as `/mnt/nas/Photos`, as its source. Use a path
   you can open on the server. A block device such as `/dev/sda3` must be
   mounted before its files can be selected. A NAS-only Ethernet link
   supplies access to the share. The first pull or source build also needs
   internet access unless the required images and packages are already local.
2. Run `bash ./Start-Here.sh` in the checkout to open the setup menu. Use an
   interactive SSH session so Bash can offer completion. Choose
   **First-time setup** or **Add a media folder**. Start typing your path,
   press **Tab** to complete it, and press **Enter** to select it. Press Tab
   twice to list matching entries when the prefix is ambiguous. Enter the
   path as you would see it on disk, including any spaces. The `--terminal`
   option forces this mode even in a desktop session.
3. Keep the default loopback binding and open a second terminal on the
   computer where you want to browse. Replace `user@ubuntu-host` with the SSH
   address you normally use and run the following.

   ```sh
   ssh -N -L 127.0.0.1:8080:127.0.0.1:80 user@ubuntu-host
   ```

   This forwards port 8080 on the browsing computer to port 80 on the
   Ubuntu server over SSH. Keep the terminal open and visit
   `http://127.0.0.1:8080` in your browser. Ctrl+C closes the tunnel. Set the
   second port to the server's published port if you picked another port.

On a fresh checkout, plain `docker compose up -d` displays setup guidance
when the manual `URL` setting is missing. Start-Here collects the folders
before launching Docker. In detached mode, Compose starts containers in the
background. It has no interactive folder prompt. For an intentional manual
deployment, configure the address and mounts in the
[manual setup guide](COMMANDS.md#get-the-source-and-start).

## Where the image comes from

The starter first pulls `docker.io/5u8han/vidstream:latest`. If that image is
unavailable, it builds from the checkout. `VIDSTREAM_IMAGE` selects another
compatible published image. The image must include the starter's Compose
generator. A failed pull of an explicitly selected image stops setup so the
user can check the image name or registry access.

See [Docker Hub publishing](DOCKER_HUB.md) for GitHub credentials, platform
checks, and verifying the registry image. For a setup that already uses a
published image, follow the registry-image update steps in the
[command reference](COMMANDS.md).
