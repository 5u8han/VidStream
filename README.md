# Stream

A self-hosted photo *and video* stream. Drop files in a folder, and they
show up — embedded SQLite for durable library choices, no database server, no build step, no cloud dependency. Optional AI is off by default.

VidStream will remain software you download/clone and run on your own machine, serving your locally available media for viewing and sharing. It is not a centrally operated media-upload/cloud-hosting service. Optional remote access still connects to your own server.

Stream is a from-scratch spiritual successor to
[waschinski/photo-stream](https://github.com/waschinski/photo-stream), built
because that project (great as it is) only handles photos. Video needed a
different foundation, not a bolt-on — see [Why a rewrite](#why-a-rewrite-and-not-a-fork)
below.

## Main and node development

**main**, version **1.8.0**, contains the consolidated development and design work. **VidStream-node** remains separate for multi-machine libraries. The old Dev and Design branches have been incorporated into main and retired. Read the [branch comparison and update guide](docs/BRANCHES.md) for the tested differences and explained commands.

Settings shows the running version, server address, owner/guest state and whether Nodes is included. After rebuilding/recreating a container, reload the browser page: an already-open tab continues running its previously loaded JavaScript. Styles and scripts carry versioned URLs on the next page load. Git source changes do not automatically replace code loaded in an open browser tab.

The sign-in, loading, welcome and first-visible-media entrances are included in main. Read the [design behavior guide](docs/DESIGN_TEST_1.md) for the once-per-visit/login lifecycle. Media, processing settings and Docker volumes retain their existing behavior.

## Browsing, catalog and saved processing

The browsing/catalog work from **VidStream-Dev-Test-1** has been merged into main. Read the [development and migration guide](docs/DEV_TEST_1.md) before upgrading a library older than that checkpoint: the durable catalog upgrades to SQLite schema 3 and keeps a pre-migration snapshot. Going back to v1.7 requires restoring that snapshot, not just switching code.

Opening media again shows the larger centered **90% browser-width and 90% browser-height** card, as in v1.6. Media fits within that card with native controls. Scroll with the pointer over the visible gallery around the player to browse underneath; click that background, use Close, or press Escape to dismiss it. Settings → View → **Viewer background blur** adjusts the backdrop from 0–30 px immediately. Blur and the new Off/Subtle/Full effects preset stay local to each browser.

Settings and View options open at a category list. Selecting a category opens its section; selecting an option keeps that section open. The Back button, Escape, clicking the backdrop and browser Back move up one level at a time, including expanded hardware guidance. Browser Forward can restore the last screen. Gallery tile spacing is 0 px when artist outlines are off and 1 px when enabled; media still uses the chosen whole-frame/cropped framing preference.

If hardware settings report 2 GiB, the default Compose container ceiling is the reason. Settings now distinguish OS/VM RAM from the container ceiling and effective CPU capacity. Read [hardware allocation and GPU setup](docs/HARDWARE.md) for Docker Desktop, native macOS and Linux/Proxmox/NVIDIA instructions.

Video playback uses the browser's native controls and original file through HTTP range requests, which allow seeking without downloading the entire file first. The player adds a **0.25×–2× speed selector** and **Stats for nerds** (chart icon). Stats reuse the library/dashboard dock as the player footer and return it to normal after closing. They display file resolution, player viewport, source FPS when known, measured presented FPS, dropped/total frames, buffered seconds, playback speed/state, codecs, and original/enhanced source. Presented FPS is measured from browser frame callbacks; older browsers show an explicitly estimated value or unavailable counters. This is client playback telemetry, separate from the server resource dashboard. Stats run only while enabled in an open video and the choice stays local to that browser.

Enhancement is a separate saved processing job; opening a video does not automatically upscale or smooth it. Render a five-second sample, compare it with the original, then queue a full version. Approving selects a separate saved result as the default player source. The additional **Publish & archive original** action explicitly replaces the hosting file and retains a verified original and recovery journal under `./originals/original` by default, outside `./media`. This action requires its own confirmation.

## Operate enhancement from the web

### Start or upgrade

```sh
git pull --ff-only
docker compose up -d --build
```

`git pull --ff-only` downloads the current branch's committed updates and applies them only when no merge is needed. `docker compose up -d --build` rebuilds and starts/recreates the application in the background with the current configuration; it retains the media mounts and named data/cache volumes.

Keep both persistent volumes. No special **enhancement** build flag is required anymore. If no password or LDAP is configured, the library is locked until owner setup is complete. Obtain the one-time owner setup code from `docker compose logs stream`, open the site, and create an owner username and a passphrase of at least 10 characters. The passphrase is stored as a salted scrypt hash under `DATA_DIR/security.json`; the one-time code is removed after setup. **Logout now returns to the sign-in screen**, rather than granting admin again. Existing `ADMIN_PASSWORD`/LDAP deployments keep their authentication. Settings → Security controls whether the whole library requires sign-in or explicitly guest-visible media can be browsed publicly. Keep HTTPS for remote access. If the local owner passphrase is lost, stop the server, move `DATA_DIR/security.json` to a private backup, and restart to create a new owner using the new setup code. This requires filesystem control and invalidates old sessions; media and library preferences remain in place.

### How enhancement works

1. Open **Settings → Enhancement** and choose **Install tools & recommended models**. The standard image already contains the small system libraries; this button downloads fixed, checksum-verified executables into the persistent data volume, plus RIFE 4.6 and Real-ESRGAN x4plus weights. No root installer, Docker socket, arbitrary executable URL, or rebuild is needed. Animation 2× is an optional separate model.
2. Enable enhancement and leave **Processing device → Detect on this server**, or explicitly choose CPU/GPU. CPU supports optical-flow smoothing and RIFE; Real-ESRGAN needs a Vulkan GPU. Disabling enhancement suspends active work and keeps queued/checkpointed work; re-enabling lets it continue. Explicitly paused/error jobs still require Resume.
3. Open a short video → **Enhance video**, choose smoothing/upscaling, and **Render 5-second sample** at a selected start time. Use **Compare original / result** before **Queue full video**. The job runs on the server even after closing the browser, saves a separate MP4, and stops. It does **one pass over the original**. Inspect motion/texture artifacts and frame-to-frame flicker before processing a large library. HDR/high-bit-depth and anamorphic enhancement are currently refused; supported output is explicitly SDR H.264/8-bit/CFR with AAC audio and no subtitle tracks.
4. To prepare the library, choose batch options in Settings → Enhancement, tick the batch confirmation, and **Queue current videos**. Only currently indexed videos are queued; future imports require another batch. Matching saved jobs are reused. Jobs run one at a time. Monitor/pause/resume them under **Jobs**.
5. Under Jobs, **Export / resume hosting library** creates `DATA_DIR/clean-library` (override with `CLEAN_LIBRARY_DIR`). It copies the newest matching completed enhancement for each video. The optional checkbox includes original photos and videos without a completed enhancement. Photos are copied unchanged; this release does not AI-enhance still images. Re-export after more jobs finish. This folder can become the media source of a separate hosting instance; do not point the enhancement source at its own export directory.

Exports preserve source paths for originals. Enhanced filenames include a job ID to avoid extension/name collisions. A checksummed manifest makes export resumable. Superseded, verified VidStream exports move into hidden `.vidstream-previous/` so only the current version is visible; original source files remain untouched. Unrelated or externally modified destination files are never overwritten. Configure a generic static host to exclude hidden directories and `manifest.json`; VidStream itself ignores hidden directories and non-media JSON. Exports do not automatically delete missing source media, and are not an automatic backup of everything. Disk space must cover snapshots, frames, results and exported copies.

### Your two server types

- **Apple M3 Pro / 36 GB:** run VidStream natively on macOS for Apple GPU acceleration. The web installer provides universal macOS NCNN/MoltenVK executables. RIFE and realistic 4× inference have been verified on this M3 Pro using small generated clips. Docker Desktop's Linux ARM guest does not expose the Apple GPU to these executables; standard CPU optical-flow smoothing remains available there. Run `npm start` natively after installing Node 22.13+, FFmpeg, ImageMagick, ExifTool and Python 3 as described below.
- **NVIDIA server / RTX 5090:** the same models are appropriate, with tiled upscaling. The app reads available GPU/VRAM instead of trusting a hard-coded memory claim. NVIDIA specifies 32 GB for the desktop RTX 5090; 24 GB may identify a different variant/model. Physical 5090 inference has not been validated here. Use a working Vulkan-capable driver and expose the GPU to Docker/your Proxmox VM once. For Docker, retain `docker-compose.gpu.yml`; a web menu cannot grant missing host/VM GPU passthrough permissions.
- **iPad / iPhone:** these are viewing/control clients. They do not need the models or compute power. Data saver, preview source, and simultaneous preview limits are local to each browser; server enhancement settings apply to the server for everyone.

Automatic executable installation supports native macOS (Apple Silicon/Intel) and Linux x86-64. The normal container also works on ARM for CPU optical flow; native upstream builds may be supplied on PATH for other platforms. The optional YOLO object-detection Python stack remains a separate `STREAM_AI_STACK` build option; it is not needed for smoothing/upscaling.

### Live resource dashboard

The dashboard polls every five seconds and displays CPU, RAM, free storage, physical disk read/write totals and rates, network bytes/rates, GPU utilization and GPU memory when exposed. Units use decimal **KB / MB / GB** (bytes, not bits); installed RAM also shows GiB to explain differences from system labels. On Linux cgroup v2, workload CPU/RAM/block I/O include worker processes; the host CPU and visible OS memory are separate. In a VM, these are the resources visible inside that VM, not unrestricted access to the Proxmox host.

On native macOS, IOKit provides Apple GPU utilization, shared-memory occupancy and storage-driver counters; netstat supplies network totals. Host counters include other applications. Node-only CPU/RAM are labeled and exclude native worker processes. Apple shared memory is not additional dedicated VRAM. Occupied Mac RAM includes caches, so it is not a memory-pressure reading. RAM occupancy is not RAM read/write bandwidth; NVIDIA memory-controller utilization is shown if available. Unavailable sensors are labeled **Unavailable**, never faked as zero. Observed read/write/network/cpu totals persist in SQLite across restarts, but activity while the server is stopped is not counted.

The View options menu has **Layout / Playback / Filters / Theme** sections, compact translucent controls, colored selected states and mobile-safe scrolling. Settings includes **Maintenance** for background-work presets, work status, storage measurements, catalog backups, relinking and interrupted-publication recovery. Recent opens, Continue watching, Less seen, saved filters and pinned actions are available from View options.

Hardware references: [NVIDIA RTX 5090 specifications](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/), [Docker GPU support](https://docs.docker.com/desktop/features/gpu/), [RIFE NCNN](https://github.com/nihui/rife-ncnn-vulkan), [Real-ESRGAN NCNN](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan).

## Version 1.2: library choices, full frames, and beta editing

- **Best / favorites, pins, bookmarks:** mark media in the viewer; use the star on a tile for a quick favorite. Pins appear first, then favorites, then bookmarks, followed by your chosen sort. Filters still apply; the Contains menu can show only one saved category. These are shared library choices, writable by admins, not separate user accounts.
- **Fit entire frame** is the default. The menu can optionally switch to Fill tile (cropped). Resizing recalculates the actual tile width each animation frame. Open a media file to pinch/pan on touch screens, double-click to zoom/reset, or Ctrl+wheel to zoom. At normal zoom the whole frame fits. Existing simultaneous-preview controls remain available.
- **Native preview FPS:** optimized previews retain source FPS up to `VIDEO_PREVIEW_FPS=60`. A 30 FPS source stays 30; no interpolated frames are invented. Old previews regenerate during the first scan after upgrade and receive new browser cache URLs. Check an older `.env` for a lingering `VIDEO_PREVIEW_FPS=12` or `15`. The Performance menu also offers full-quality original playback (higher bandwidth/decoder cost) and Pause/resume previews. Browser/device limits can still drop frames; reduce simultaneous decoders when needed.
- **Info:** the `i` panel opens below the stationary toolbar. It includes dimensions/pixel count, file size, import/modification/birth dates where available, codecs, source/preview FPS, camera/lens information and ExifTool metadata. Admins also see file paths, embedded GPS, and recent revision history. An Internet download date cannot be recovered when the source does not contain it.
- **Motion:** stable menu controls, lower background rendering load, no periodic canvas flash, retained pointer trails and click glow. The compact glass footer contains the library counts and dashboard.
- **Crop & trim beta:** Quick edit now offers a pixel crop rectangle, output width, and video start/end times with a preview. Save writes the edited media as the main file, keeps its identity/favorites, then refreshes previews. Originals and a recovery manifest are stored under `MEDIA_DIR/.vidstream-originals/<revision>/`; this hidden folder is excluded from scanning. JPG/JPEG, PNG, WebP photos and MP4/M4V/MOV/MKV/WebM videos are supported. Animated images are excluded. Video edits re-encode and can take time. Rotation, brightness and volume remain viewing-only controls. Editing requires a writable media mount; the supplied SMB overlay is intentionally read-only and will report an error instead of replacing files.

### Update an existing deployment

Keep your existing `.env`, media mount, and `stream-cache` volume. Merge any local Compose customization when pulling:

```sh
git pull --ff-only
# In .env, use VIDEO_PREVIEW_FPS=60 for native previews capped at 60.
docker compose up -d --build
```

Compose uses `stream-data:/app/data` with `DATA_DIR=/app/data`. The catalog, permanent media identities, variants, favorites, activity and jobs live in SQLite with WAL journaling. Existing JSON catalog records import once; the JSON file is no longer authoritative. Derivatives remain in `stream-cache` and can be rebuilt. The SQLite file must stay on local storage rather than an SMB/NFS share. Compose also mounts `./originals:/app/originals` for publication archives; keep that directory when replacing application files.

Without Compose, set `DATA_DIR` to a persistent local directory (default: `CACHE_DIR/library-data`). Node **22.13+** is required. When upgrading from a non-Compose 1.2 installation, retain the same `DATA_DIR` or copy its contents while Stream is stopped.

**Backups:** stop Stream and back up the complete data directory/volume, cache volume, `.env`, media, and `.vidstream-originals`. Restart after the copy. Do not remove persistent volumes with `docker compose down -v`. Code updates do not erase data, but deleting a volume does. To restore an archived edit, stop Stream, consult that revision's `revision.json`, copy its `original.<ext>` back to the recorded library-relative path, then restart/rescan. Every revision retains a complete original. Automatic backup scheduling and an in-app restore browser would be useful next additions.

Identity uses a permanent media ID. Unambiguous moves of an absent source are matched by content hash; present copies remain separate items. Ambiguous matches are retained rather than guessed. Maintenance offers a verified manual relink to an unclaimed path. Old link IDs remain aliases. Artist display labels can be changed independently of source paths.

### Models and offline placement

Dashboard → Optional AI models & hardware lists ten compatible detection presets and their exact local paths. Downloads use pinned revisions of the official Ultralytics YOLOv8 and YOLO11 Hugging Face repositories. You can download weights without installing the inference stack; inference still needs `STREAM_AI_STACK=true` and a rebuild. For offline use, copy the named `.pt` file to the displayed models directory (normally `/app/.cache/models` inside the container), choose it, save/enable, then rescan. Only compatible detection presets are offered; arbitrary Hugging Face LLMs or diffusion models cannot run in this object-detection pipeline. Load trusted weights only and review the displayed model license.

### Implementation references

[Full-frame media sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit), [glass blur](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter), [frontend design guidance](https://github.com/aladicf/better-web-ui/blob/main/skills/frontend-design/SKILL.md), [Node SQLite](https://nodejs.org/api/sqlite.html), and [Hugging Face downloads](https://huggingface.co/docs/hub/models-downloading).

## Features

- **Photos and video, side by side**, in one chronological stream.
- **Video previews autoplay** — muted and looped — as soon as a tile scrolls
  into view (so anything visible when the page first loads starts playing
  immediately), and again on hover. Click to open with full quality, sound,
  and scrubbing, with a slideshow mode in the lightbox.
- **Responsive by default.** The grid scales continuously with your browser
  width, with a small/medium/large density control in the menu, a live tile-width slider, and 1×/2× video tile sizes. Photos and
  video posters are served as real `srcset` variants at several
  resolutions, so a phone doesn't download the same image as a 4K monitor.
- **Local detection, no cloud APIs**: face/pet presence detection, general
  object detection (person/dog/car/... 80 classes), OCR text search, and
  near-duplicate grouping — see [Detection](#detection) below for exactly
  what this does and doesn't cover.
- Instant-paint tiles: each tile's dominant color renders immediately, before
  any image/video data has loaded.
- True masonry grid (real aspect ratios, no cropping), lazy-loaded and
  infinite-scrolling.
- Every item gets a stable, shareable permalink (`/your-photo-slug`) with
  proper Open Graph tags for link previews, plus a keyboard- and
  swipe-navigable lightbox.
- **Multi-select** (the header's checkmark icon): tap tiles to select them,
  then download the selection as a zip (or a direct file for a single
  item) from the action bar that slides up — admin sessions also get bulk
  guest-visibility actions there.
- **Quick edit and info panel** in the lightbox: non-destructive,
  session-only rotate/brightness/volume (never written back to the file,
  resets when you move to the next item), and an info sidebar with
  dimensions, file size, date, camera make/model/lens/exposure (photos),
  codec/frame rate/bit rate (video), and whatever detection found.
- Sort by newest, oldest, filename, shuffle, or creator groups; filter by type, album, or
  "contains" (faces/pets/text/detected objects); search filenames and OCR'd
  text; RSS feed; Web Share API (with clipboard fallback); optional
  original-file downloads.
- **Four themes** (Light Table, Darkroom, Golden Hour, Contact Sheet) plus
  a System option that follows your OS — picked per-visitor from the menu,
  remembered locally. A **Data saver** toggle there too, off by default,
  for anyone on slower hardware/connections.
- Auto-detects new files dropped into your media folder — no rebuild, no
  restart.
- **Optional admin/guest split**: keep your library private by default and
  explicitly mark individual photos, videos, or whole albums as
  guest-visible — see [Admin mode](#admin-mode) below.
- **Library counts, and nothing silently missing.** A fixed bottom audit bar shows
  "114 photos · 222 videos · 3 unsupported · 63 unreadable · 402 total" (the
  total includes the files that didn't import); click the unsupported/
  unreadable chips for a folder-by-folder list with the reason for each.
- **iPhone-ready formats**: HEIC/HEIF, TIFF and BMP alongside JPEG/PNG/GIF/WebP.
- **Private by default if you want it**: `REQUIRE_LOGIN=1` turns the whole app
  into a login screen for signed-out visitors; sign in with a username and
  password, or against LDAP (e.g. Synology Directory Server).
- **Ambient background** behind the grid that reacts to scrolling (tiles that
  scroll past leave a trail of their own color), the pointer, and the sound of
  a video playing in the lightbox; the header and footer have a hover
  spotlight with a trailing ghost and parallax. Both switch off for
  reduced-motion and Data saver.
- **Zero npm dependencies.** External tools are `ffmpeg`, ImageMagick,
  OpenCV (Python), Tesseract, and (optionally) PyTorch/YOLO for object
  detection — all included in the Docker image.

## What's new: fast previews, creators, dashboard and optional AI

- **Up to 60 FPS video previews:** `VIDEO_PREVIEW_FPS=60` is the encoding ceiling. It cannot invent motion absent from 24/30 FPS source material or force 60 FPS browser composition on slow clients. Existing cached videos are re-encoded during the next scan when the setting changes. Preview files are muted MP4s; full originals are opened in the lightbox.
- **Smooth browsing first:** no frontend framework, no client-side video transcoding. Preplaying tile concurrency is configurable from 4 to 64 (default 8, with hover priority), and hidden tabs pause playback. This prevents dozens of decoders overwhelming the browser.
- **Resize videos:** click the expand icon at the bottom right of a video to toggle 2-column width. The View options menu includes global Normal/2× video settings and an adjustable tile-width slider. On narrow screens 2× falls back to one column.
- **Creator grouping:** the first media subfolder is treated as creator/artist (for example `Artist/Collection/clip.mp4` → `Artist`). The full relative subfolder is still an album. Tiles get creator-colored hover outlines and a label showing the origin. Select **All media · artist A–Z** in View options to clear filters and sort the entire library by artist, then filename. This sort ignores favorite/pin priority and keeps the packed layout. Use the creator dropdown to filter. Under **View options → Layout → Artist outlines**, choose fine per-tile borders or hover/focus-only highlighting; colors may repeat and can be shuffled.
- **Filters:** creator, album, media type, date created/taken, date *imported into Stream*, and minimum resolution measured using the shorter image dimension. The import date is a local Stream import timestamp, **not** the original internet upload/posting date, which generally isn't embedded in downloaded media.
- **Always-on footer:** counts of indexed photos/videos, unsupported types and unreadable files, plus last scan time.
- **Library map:** the dashboard treemap includes all indexed photos and videos regardless of gallery filters. Size blocks by storage bytes or file count; click an artist to drill into files, or select **Every media file** to see files nested inside artist blocks. The artist and file selectors support keyboard/touch navigation. Files with unknown/zero sizes receive a minimal area so they remain represented.
- **Audit dashboard:** available to administrators from the chart icon or footer. It displays creator/format/resolution charts, imported files (paginated), processing durations, recent scans, and errors. Stream does not silently read host syslogs; that would require invasive permissions. Use `docker compose logs stream` for container logs.
- **Optional object models:** open Dashboard → Optional AI models & hardware. Stream reports CPU, effective memory and NVIDIA GPUs visible inside the container, and offers official YOLOv8 and YOLO11 nano/small/medium/large/extra-large model downloads from Hugging Face. Install and enable a model only if you need AI tags. A new scan refreshes object analysis. This feature is independent of faster photo/video browsing.

### AI model installation (optional)

The default image **does not** install large PyTorch/Ultralytics packages or download model weights. For CPU inference, set `STREAM_AI_STACK=true` in the shell or `.env`, then rebuild:

```sh
STREAM_AI_STACK=true docker compose up -d --build
```

Open the admin dashboard. It shows supported downloadable models. Choose a model, click Download, then Save AI settings with Enable selected, then Rescan. Weights survive rebuilds in the persistent `.cache` volume; AI preferences live in the persistent `DATA_DIR` volume (legacy settings are migrated automatically). The UI does not support arbitrary model URLs or arbitrary Python execution.

For Linux with an NVIDIA GPU, install NVIDIA drivers and NVIDIA Container Toolkit **on the host**. The Compose GPU overlay passes hardware into the container:

```sh
STREAM_AI_STACK=true STREAM_AI_ACCELERATOR=cuda \
  docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

The dashboard shows what Docker exposes. Choose CUDA:0 after validating that the container can run CUDA-enabled PyTorch and `nvidia-smi`; otherwise choose CPU/Auto. GPU passthrough can't be activated by a webpage; it is a Docker host deployment decision. macOS Docker Desktop generally cannot pass through a Mac's Metal GPU to this Linux container. Support for ROCm/AMD/Jetson would require additional build and runtime paths.

**Model costs:** GPU inference and larger models need more system RAM and possibly substantially more than the default `STREAM_MEM_LIMIT=2g`. Increase that limit when using medium weights. Model quality and memory usage should be tested on your target hardware. Ultralytics weights/packages have their own license terms.

### GitHub publishing (no personal media in the repository)

Create an empty GitHub repository named e.g. `stream` (do **not** add a README when creating it), then from the folder containing `server.js`:

```sh
git init -b main
git add .
git status --short        # verify NO media/.env/.cache/rclone.conf are staged
git commit -m "Stream: fast media gallery and audit improvements"
git remote add origin https://github.com/YOUR_USERNAME/stream.git
git push -u origin main
```

If the included archive was checked out from a Git repository already, skip `git init`. Never `git add -f` a secret or personal media. Set repo visibility **private** while you check the original Claude code, local credentials and license obligations. `npm test` executes the new regression tests, and GitHub Actions runs the same checks on pushes/PRs.

### File index and NAS tolerance

The catalog is durable SQLite; SQL handles filtering, ordering and paging while an in-memory record map supports existing media routes. An unavailable SMB/NAS directory is recorded as offline and missing files are retained with their history. Posters/basic metadata become available before preview generation and analysis. Source files remain read-only with the SMB overlay; editing/publication requires a writable mount. Existing cached media may remain visible while originals are offline.

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env — at minimum, set TITLE and URL
mkdir -p media
docker compose up -d
```

Put photos and videos in `./media` (subfolders become albums). Visit
`http://localhost:4000`. New files are picked up automatically; if you'd
rather trigger it by hand, POST to `/api/rescan` or use the refresh icon in
the header.

### ARM and x86

Both work from the same files — nothing in the image is architecture-specific
(Debian base, PyTorch's CPU wheels exist for both). On any one machine,
`docker compose up -d --build` builds natively for that machine, whether it's a
Raspberry Pi, an Apple-silicon Mac, an ARM NAS or an ordinary x86 server. To
publish a single image that runs on both:

```bash
scripts/build-multiarch.sh yourname/stream:latest --push
```

(The ARM half built on an x86 box runs under QEMU and is slow, mainly the
PyTorch install — set `ENABLE_OBJECT_DETECTION=false` to skip it.)

## Quick start (no Docker)

Requires Node.js 22.13+, `ffmpeg`, ImageMagick (`convert`), ExifTool, Python 3
with OpenCV (`python3 -c "import cv2"` should not error), and `tesseract`
on your PATH. Detection features degrade gracefully (skipped, not crashed)
if any of these aren't installed.

```bash
cp .env.example .env
node server.js
```

## Deploying with Cloudflare

**A Cloudflare Worker can't run this app.** Workers are short-lived V8
isolates: no filesystem and no subprocesses, so no ffmpeg, ImageMagick,
OpenCV or Tesseract, and no long-running scanner. A Worker that *caches* Stream
at the edge would be actively harmful, too: access checks happen at the origin,
so a cached private photo could be served to someone who isn't signed in.

What is deployable — and what people usually mean — is **Cloudflare Tunnel**:
a small `cloudflared` container makes an outbound-only connection from your
server to Cloudflare, which routes `photos.example.com` to it. No open ports,
no exposed home IP, TLS handled for you.

1. Zero Trust dashboard → Networks → Tunnels → create a tunnel, copy its token,
   and add a public hostname `photos.example.com` → service `http://stream:4000`.
2. In `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   URL=https://photos.example.com
   TRUST_PROXY=1          # rate-limit logins per real client IP, not the tunnel's
   REQUIRE_LOGIN=1        # signed-out visitors see only a login screen
   ADMIN_USERNAME=you
   ADMIN_PASSWORD=<long and random>
   ```
3. `docker compose --profile tunnel up -d --build`

Session cookies get the `Secure` flag automatically when Cloudflare reports
HTTPS. For a second gate in front of the app, add a Cloudflare Access policy to
the hostname (email one-time-code or SSO) — it sits before Stream's own login.

**Check Cloudflare's current terms before pushing lots of video through it.**
Cloudflare's 2023 terms rewrite moved its restriction on serving video and
other large files into CDN-specific terms (such content is fine when hosted on
its own Stream/Images/R2 products), and community reports conflict on whether
personal, uncached Tunnel streaming is tolerated. A handful of viewers is
commonly done; heavy streaming is the risky case. If you only need access from
your own devices, a private mesh VPN (Tailscale, WireGuard) has no such
question at all — and for a homelab that isn't public yet, it's the simplest
secure option.

## Remote storage

Keeping the whole library on the container's own disk gets expensive fast,
so rather than build bespoke, fragile integrations for each of the dozen
services people asked about, the practical answer is **rclone**: it already
has mature, actively-maintained backends for Google Drive, Dropbox,
Mega, S3, and 40+ others, and mounting one as a local-looking folder means
Stream's existing scanner just works against it — no app changes needed.

```bash
rclone config    # one-time: authenticate the remote you want (e.g. "gdrive")
docker compose --profile remote up -d
```

The `rclone` service in `docker-compose.yml` mounts `remote:path` at
`./media` with VFS caching enabled — recently-viewed originals stay
cached locally for speed, older ones get evicted, and the *derivatives*
Stream generates (thumbnails, posters — the actually-expensive-to-regenerate,
cheap-to-store part) live in the separate `stream-cache` volume regardless.
That combination is what keeps local disk use low without re-downloading
constantly.

The rclone mount is `--read-only`, so Stream can never modify or delete
anything on your remote. A caveat on the sidecar container: a FUSE mount made
inside one container and shared with another depends on Linux mount
propagation, which Docker Desktop (macOS/Windows) doesn't support well. The
more robust route is to run `rclone mount` on the *host* (a systemd service)
and bind-mount that folder into Stream like any other — treat the compose
profile as the advanced/Linux option. If your files live on a Synology/NAS
share rather than a cloud provider, use SMB directly instead — see
[Running on a NAS](#running-on-a-nas).

Two explicit exceptions, so this isn't oversold:
- **Google Photos** isn't supported, by anyone, anymore — Google removed
  third-party read access to an existing library from the Photos API in
  April 2025; apps can now only see content they themselves uploaded. If
  your photos are in Google Photos specifically, [Google Takeout](https://takeout.google.com)
  to export them into a folder (or a Drive folder rclone can reach) is the
  practical path.
- **imgur** is built for public sharing/hosting, not personal library
  storage or backup, and doesn't fit this use case well even where its API
  allows it — not recommended as a primary store for the same reason you
  wouldn't want randoms finding your library on imgur's own site.

## Running on a NAS

Stream only ever *reads* `MEDIA_DIR`. Everything it writes — the index,
thumbnails, posters, preview clips, the generated session secret — goes to
`CACHE_DIR` (the `stream-cache` Docker volume). Durable user choices live in `DATA_DIR`; beta edits archive originals beside your library in `.vidstream-originals`. (A
test that scans, serves thumbnails and originals, downloads a zip and rescans
leaves the media folder byte-for-byte unchanged.) Mount the library read-only
for a hard guarantee.

- **Docker runs on the Synology/QNAP/TrueNAS itself:** bind-mount the shared
  folder directly — no network filesystem involved:
  `volumes: ["/volume1/photos:/media/original:ro"]`.
- **Docker runs elsewhere, library is on an SMB share:** use the SMB override
  (the share is mounted read-only; caches stay in Docker's own volume):
  ```
  # .env: SMB_HOST, SMB_SHARE, SMB_USER, SMB_PASS  (a dedicated read-only account)
  docker compose -f docker-compose.yml -f docker-compose.smb.yml up -d --build
  ```
  The Docker *host* needs `cifs-utils`. Change notifications don't cross an SMB
  mount, so the override polls (`SMB_RESCAN_MINUTES`, default 15) instead of
  watching. Avoid commas in the SMB password — they separate mount options.
- **NFS, or an SMB share you'd rather mount yourself:** mount it on the host
  (`mount -t nfs nas:/photos /mnt/photos`) and bind-mount that path. A symlink
  *on the host* works too; a symlink *inside* the container wouldn't resolve.

## Configuration

Everything is a `.env` variable — see [`.env.example`](.env.example) for the
full list with comments. Nothing is required; an empty `.env` runs with
sensible defaults (fully public, no sign-in, detection on, three responsive
sizes per derivative).

## Supported formats and the "unsupported" list

Photos: JPEG, PNG, GIF, WebP, **HEIC/HEIF**, TIFF, BMP. Videos: MP4, MOV, WebM,
MKV, M4V, AVI. Everything else in the folder (RAW files like CR2/NEF/DNG, PSDs,
documents, …) is counted as *unsupported* and listed — by folder — behind the
chip in the footer, so nothing just vanishes. A file with a supported extension
that can't be decoded (corrupt, truncated, or a variant the decoder doesn't
handle) lands in *unreadable*, with the reason. Signed-out visitors only see
counts for what they're allowed to see, never the lists.

HEIC decoding needs ImageMagick's libheif delegate; the Docker image requests
it explicitly. If your build can't decode HEIC, those files show up under
*unreadable* with an error rather than disappearing.

## Detection

Runs locally during processing, no cloud calls:

- **Face & pet presence** — OpenCV's own bundled Haar cascade classifiers
  (shipped inside the package, no model download). Flags "there's a face
  here" and "there's a cat here" for filtering — not *whose* face, and not
  fine-grained body-region analysis. Accuracy is real but classical-CV-grade,
  not deep-learning-grade: expect to miss some non-frontal angles.
- **General object detection** — YOLOv8n (a real, modern, multi-class
  detector: person, dog, cat, car, bicycle, chair, dining table, laptop,
  and the rest of the 80 COCO classes), layered on top of the Haar-cascade
  check above. This is the heavier, optional half of detection — see
  [Deployment note](#quick-start-docker) — a build arg controls whether the
  model even ships in the image (`ENABLE_OBJECT_DETECTION`, default on),
  and a matching `.env` variable controls whether it's used at runtime.
  A persistent worker process (`lib/vision-objects.js` +
  `lib/vision/object_worker.py`) keeps the model loaded between files
  instead of reloading it — multi-hundred-MB model load time per photo
  would make scanning a real library impractical otherwise — but
  inference itself is still real CPU work, so expect scanning to be
  slower with this on than off.
- **OCR** — via Tesseract. Extracted text becomes searchable, so a
  screenshot, receipt, or sign turns up in a filename/text search.
- **Near-duplicate detection** — perceptual hashing (dHash) groups
  visually-similar burst shots for cleanup, via `/api/duplicates`. No
  trained model involved, just image resizing. Tunable via
  `DUPLICATE_THRESHOLD` — see the note in `.env.example` about occasional
  false-positives on very low-detail/uniform images, an inherent property
  of the technique.

**What's deliberately not here:** true scene/setting classification
("beach", "sunset", "wedding") and face *clustering* (grouping every photo
of the same person, like Google/Synology Photos' "People" view) — the
former needs a differently-trained model than an object detector, the
latter needs face embeddings, and neither is included. If you want to add
either, `lib/vision-faces.js` and `lib/vision-objects.js` are the
integration points — swap in a model-backed classifier there and thread
the resulting tags through `lib/scanner.js` → `lib/db.js` →
`lib/serialize.js` the same way `hasFace`/`objects`/`hasText` already flow.

## Access control

Three modes, depending on what you set:

1. **Nothing set** — fully public.
2. **`ADMIN_PASSWORD`** (optionally `ADMIN_USERNAME`) — two tiers. Signed-out
   visitors see only items you've marked guest-visible (the eye icon on a tile,
   in the lightbox, per album, or in bulk from the selection bar); signing in
   shows everything plus those controls. Direct links to private items 404.
3. **`ADMIN_PASSWORD` + `REQUIRE_LOGIN=1`** — fully private. Signed-out
   visitors get a login screen and nothing else: the page shell, `/api/*`,
   `/media/*` and the RSS feed all refuse them. Recommended for a homelab.

**LDAP / Synology.** Set `LDAP_URL` and `LDAP_BIND_DN_TEMPLATE` and users can
sign in with directory accounts; the static password still works as a
break-glass login if the directory is unreachable. Stream tests credentials by
doing an LDAP bind with the standard `ldapwhoami` tool (in the image) rather
than implementing the protocol itself. For Synology you need the **Directory
Server** (or LDAP Server) package — its users live in that package's own
directory, separate from the NAS's local DSM accounts, so create or import them
there. Per Synology's guide, users bind as
`uid=<username>,cn=users,<Base DN>`, so:

```
LDAP_URL=ldaps://nas.local:636
LDAP_BIND_DN_TEMPLATE=uid={username},cn=users,dc=home,dc=lab
```

If your server runs in Active-Directory mode, use `{username}@home.lab`
instead. Use `ldaps://` — plain `ldap://` sends passwords unencrypted — and for
a self-signed certificate set `LDAPTLS_CACERT` (preferred) or
`LDAPTLS_REQCERT=never`. **Every account that can bind becomes a full admin**;
there are no per-user permissions, so point it at a directory you trust. This
path was verified against a stand-in for `ldapwhoami`, not a live LDAP server —
test a login against yours before relying on it.

**Safeguards:** the session-signing secret is randomly generated on first run
(and the `.env.example` placeholder is ignored, so a copied file can't leave a
known secret in place); failed logins are rate-limited (8 per 10 minutes, per
client); passwords are compared in constant time; usernames are restricted to a
safe character set before touching an LDAP DN; sessions are 30-day HttpOnly
cookies, `Secure` behind an HTTPS proxy; the build excludes `.env` from the
image. **Stream does not terminate TLS itself** — put it behind HTTPS (a
reverse proxy, Cloudflare Tunnel, or a Tailscale address) rather than sending
passwords over plain HTTP, even at home.

## Performance & reliability

- **Caching**: derivative files (thumbnails, posters, previews) are served
  with `Cache-Control: immutable`, so a browser that's already loaded
  something never re-fetches it for the rest of that session — this is
  what actually gets you "already-viewed media stays fast," rather than
  anything the app could force beyond normal browser caching behavior.
- **Hung subprocesses can't accumulate**: every ffmpeg/OpenCV/Tesseract
  call has a timeout and gets killed if it doesn't finish, instead of
  silently occupying a processing slot (and OS memory) indefinitely.
- **The file watcher restarts itself** every 6 hours as a bound against
  slow growth in Linux's recursive `fs.watch`, and has proper error
  handling so a watch failure (e.g. a flaky network mount) can't crash the
  process.
- **Container-level memory limits** (`mem_limit` in `docker-compose.yml`,
  paired with `restart: unless-stopped`) mean any of the above degrading
  further shows up as a clean restart, not a wedged host.
- **Data saver** (in the menu, off by default): disables autoplay previews
  and loads images later, for anyone on constrained hardware/connections —
  a per-visitor choice, independent of the server-wide
  `VIDEO_AUTOPLAY_PREVIEWS` setting.

## Architecture

```
server.js               entry point: wires everything together
lib/
  scanner.js             walks the media folder, diffs against the index,
                         dispatches processing, watches for changes
  media-photo.js          thumbnail/large derivatives (multiple widths),
                         EXIF date, + detection, via ImageMagick
  media-video.js           poster frames (multiple widths) + muted preview
                         clip + duration/audio + detection, via ffmpeg
  vision-faces.js          face/cat presence (calls vision/detect.py)
  vision-ocr.js            text extraction (calls the tesseract CLI)
  vision-hash.js            perceptual hashing for duplicate grouping
  db.js                   JSON-backed in-memory index (query/paginate/sort/
                         search/guest-visibility/duplicate-grouping)
  auth.js                 signed-cookie admin sessions (no user accounts)
  router.js, serve-file.js, handlers/   a small hand-rolled HTTP layer,
                         including HTTP Range support for video scrubbing
public/
  app.js                 grid rendering, lazy loading, the autoplay/hover
                         logic, the lightbox, menu, search, admin controls
  styles.css              theme tokens and all UI states
```

Derivatives (thumbnails, posters, preview clips) are cached under `CACHE_DIR`.
Content versions and per-stage processing recipes are separate. A changed
preview size rebuilds that stage without invalidating a saved enhancement
of unchanged source bytes. Replacements are generated separately and
promoted only after successful processing; failures retain existing previews.

## Why a rewrite, and not a fork

photo-stream is a **static site generator**: Jekyll (Ruby) reads
`photos/original`, and Ruby plugins (libvips + ExifTool) bake out three
resized JPEGs per photo at build time. Photos are meant to live *in the git
repo* (or a volume that stands in for one) and get rebuilt on each commit.

That model runs into real trouble with video specifically:

- **Git and large binaries don't mix.** GitHub hard-blocks files over
  100MB, and repo size balloons fast with video — a workflow that's mildly
  annoying for photos becomes untenable for video.
- **libvips doesn't touch video at all**, so there's no derivative pipeline
  to extend — poster frames, preview clips, and duration/audio probing all
  need a different toolchain (ffmpeg) bolted on regardless.
- **The Ruby/libvips/Jekyll toolchain is genuinely fragile to stand up** —
  the project's own issue tracker shows recurring native-gem and
  bundler-vs-platform errors on setup.

Given that, extending the Ruby codebase would mean fighting its foundation
at every step. Stream keeps the parts that made the original good — no
database, `.env`-driven config, Docker-first, drop-files-and-go simplicity,
progressive-loading tiles, unique permalinks, RSS — and rebuilds the
storage and processing model around a folder you point at (not a git repo)
with ffmpeg/OpenCV/Tesseract as the processing dependencies, so photos and
video go through one coherent pipeline instead of two.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the original photo-stream
project; built in its spirit, with real appreciation for the original design.

## Version 1.3: settings, history and saved enhancement

Open **Settings** in the header or press **/** (outside a text field). Escape closes the popup. View options still contains the grid controls, including **Randomly enlarge video previews**. Each shuffle creates a saved pattern across the library; newly loaded pages use the same pattern. Manual tile enlargement takes precedence until the page reloads. Administrator view preferences are stored in the library database and restored on another browser; guests retain local preferences.

Activity is recorded in `DATA_DIR/library.sqlite`: the media path and ID, an anonymous browser ID, timestamps, intentional hovers (500 ms), viewer opens/closes, plays/pauses, seeking, completed playback, download clicks, enhanced playback and watched seconds. An **open** means opening the viewer; autoplaying a grid preview does not count as an open. Watched time excludes hidden tabs, pauses and buffering, and is sampled every second. It is an approximate engagement measure, not an exact audit of human attention. Pending events are saved in browser storage and retried after reconnecting; duplicate deliveries do not increase counts. Clearing browser storage before delivery loses those unsent events. Settings can disable new recording; existing records remain. History is administrator-only, and the media Info panel shows totals. Application revisions and index rebuilds do not reset the database.

### Optional enhancement

Open a video and choose **Enhance video**. Nothing is enhanced merely by browsing. Choose smoothing, upscaling, or both, render a selected five-second sample, compare, then queue a full video. Completed jobs offer playback/download and explicit approval. Originals remain unchanged unless you confirm **Publish & archive original**; that separate action preserves a verified archive and supports restore. Jobs continue after closing the browser and can be paused/resumed in Settings. The [development guide](docs/DEV_TEST_1.md) specifies output policy, storage and recovery limits.

* **Optical flow to 60 fps:** included in the standard installation, uses FFmpeg's motion interpolation on the CPU, no model required. This is not AI. Motion interpolation can introduce artifacts around cuts, rapid movement or occlusion.
* **RIFE 4.6 to 60 fps:** optional AI interpolation. Download its pinned data-only model from the official [RIFE NCNN repository](https://github.com/nihui/rife-ncnn-vulkan) through Settings. Supports CPU or Vulkan graphics hardware with the optional runtime.
* **Real-ESRGAN 4× realistic / 2× animation:** optional frame upscaling with pinned NCNN weights from the [Hugging Face edgetools mirror](https://huggingface.co/edgetools/realesrgan) of the upstream models. Requires the [Real-ESRGAN NCNN Vulkan runtime](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) and a compatible Vulkan device. Only these supported models are accepted; arbitrary Hugging Face Python repositories are not executed. AI upscaling can invent texture and is not guaranteed to improve every video. Outputs are limited to 8192 pixels per edge.

Starting in 1.4, use **Settings → Enhancement → Install tools & recommended models** on the standard build. See the current instructions above for native Mac support, Linux/NVIDIA passthrough, architecture limits and storage requirements. The old `STREAM_ENHANCEMENT_TOOLS` build flag remains accepted for preinstallation but is no longer necessary.

### Changing machines and recovery

The **server** does object detection and enhancement. Opening the site on another phone or computer does not transfer that workload. Object detection checks CUDA availability on startup and falls back to CPU if a saved CUDA preference is unavailable. Enhancement Auto checks the server again when a job starts/resumes; select GPU explicitly for a non-NVIDIA Linux Vulkan device. Native Apple Silicon GPU detection is also supported in 1.4. Real-ESRGAN always uses Vulkan. Missing models/runtimes or processing errors pause a job with a visible explanation, preserving its completed work.

Each enhancement saves a source snapshot, verifies it with SHA-256, saves AI output frame checkpoints, and assembles verified approximately two-second encoded segments. On resume, verified work is reused; corrupt or unfinished outputs are regenerated. CPU optical flow checkpoints whole segments. An interrupted model download retains verified completed files and retries the incomplete file. Snapshots, frames and final outputs remain under `DATA_DIR/enhancements`; this can consume **much more space than the original video**. Only one enhancement job runs at a time.

To move work to a more powerful server:

1. Stop VidStream on the old server, then copy its **entire persistent data directory/volume** (`stream-data`, mounted at `/app/data` by default), including SQLite, `enhancements` and `enhancement-models`. Copy source media and the separate originals archive. Copy `stream-cache` to retain previews and object detection model downloads; the catalog now lives in the data volume.
2. Restore both volumes on the new server, preserve the media directory layout and mount paths, install the appropriate runtime/driver, then start VidStream there. Never start both hosts with these shared files; this is a single-host migration workflow, not distributed processing. The local worker lease is an additional guard, not a shared-network-storage guarantee.
3. Queued/interrupted running jobs resume automatically. Explicitly paused/error jobs stay paused until **Resume** is selected. Once a source snapshot is complete, that job can resume even if the original NAS is temporarily offline. A partially copied source still requires the original to finish its verified snapshot.

For Docker volume migration, use `docker volume inspect` to identify your actual Compose-prefixed volume names, and back up/restore **both volumes while the application is stopped**. Do not run `docker compose down -v` during upgrades: it deletes the persistent volumes. Updating normally is `git pull --ff-only` followed by your chosen `docker compose … up -d --build` command.

Durable file writes, checksums and SQLite transactions protect completed checkpoints against ordinary process/network interruptions. They cannot guarantee zero loss from damaged storage, deleted volumes, unsent browser events or a power failure during unfinished work. Maintain backups. Already completed frames/segments survive; the current unfinished frame/segment may need to be rerun. Changing enhancement options creates a separate job rather than reusing incompatible output.
