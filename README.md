# Stream

A self-hosted photo *and video* stream. Drop files in a folder, and they
show up — no database, no build step, no cloud dependency.

Stream is a from-scratch spiritual successor to
[waschinski/photo-stream](https://github.com/waschinski/photo-stream), built
because that project (great as it is) only handles photos. Video needed a
different foundation, not a bolt-on — see [Why a rewrite](#why-a-rewrite-and-not-a-fork)
below.

## Features

- **Photos and video, side by side**, in one chronological stream.
- **Video previews autoplay** — muted and looped — as soon as a tile scrolls
  into view (so anything visible when the page first loads starts playing
  immediately), and again on hover. Click to open with full quality, sound,
  and scrubbing, with a slideshow mode in the lightbox.
- **Responsive by default.** The grid scales continuously with your browser
  width, with a small/medium/large density control in the menu. Photos and
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
- Sort by newest, oldest, filename, or shuffle; filter by type, album, or
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
- **Library counts, and nothing silently missing.** A summary line shows
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

Requires Node.js 20+, `ffmpeg`, ImageMagick (`convert`/`identify`), Python 3
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
`CACHE_DIR` (the `stream-cache` Docker volume), never beside your photos. (A
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

Derivatives (thumbnails, posters, preview clips) are cached under
`CACHE_DIR`, keyed by a content fingerprint that also covers your size and
detection settings — so a rescan only reprocesses files that actually
changed, and changing any of those settings reprocesses everything exactly
once to pick it up.

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
