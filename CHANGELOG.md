# Changelog

## 1.10.0 — Direct controls and focused media hosting

- Replaced the Settings category launcher with immediately visible appearance, player, library and account controls. Nodes, maintenance and history use direct disclosures and load only when requested.
- Simplified View options into a single panel with one media-size slider. Removed overlapping global size/density controls; individual and randomized video enlargement remain available.
- Removed video upscaling, smoothing/interpolation, enhancement runtimes/model downloads, job execution/control, sample comparison and clean-library exports from the product. Prepare media externally and mount the finished folder instead.
- Preserved source files, existing outputs, archives and historical database records. Retired jobs do not resume; normal preview generation, native playback, compatible playback copies and optional search recognition remain.
- Kept the 90% viewer, first-visit lifecycle, browser-local effects, zero-gutter gallery, persistent preferences and independent library switching.
- Validation: 99 unit/integration tests, 33 common browser checks, 21 node browser checks and 14 Compose configuration checks passed. Browser suites reported zero page errors. An isolated Docker build/import/range-playback check passed using generated media; no live deployment or personal media was changed.

## 1.9.0 — Integrated main and explicit Docker storage

- Merged the reviewed node branch into main, preserving both histories. Main is the official release with independent library switching; future node experiments can remain on VidStream-node.
- Removed the repository media-folder skeleton and automatic host media bind. Operators explicitly enable an existing folder at the stable container path `/media/original`; the commented example is read-only and rejects missing host paths.
- Published standard HTTP port 80 by default, configurable with `STREAM_HTTP_PORT`, while keeping the container's HTTP port at 4000. HTTPS/443 still requires proper TLS termination; hostname resolution remains a LAN responsibility.
- Kept catalog/cache volumes and moved new installations' default archive storage to the persistent `stream-originals` volume. Existing archive binds must be retained when upgrading until deliberately migrated.
- Updated installation, upgrade and node-address guidance. Existing private deployment overrides continue to supply external media and archives. No new animation or gallery behavior is introduced here.
- Validation: 132 unit/integration tests, 28 common generated-media browser checks, 21 independent-library browser checks and 14 Docker configuration checks passed. Both browser suites reported zero page errors. This release was not deployed automatically; the user will pull and rebuild it.

## 1.9.0-node.2 — node build visibility and common fixes

- Brought the consolidated main fixes into the separate node branch without merging node features into main.
- Added visible running-version/server/owner information and versioned assets; an existing tab must be reloaded after updates.
- Preserved owner controls on obsolete media URLs and show Nodes with a sign-in explanation for guest views while retaining private API checks.
- Updated guidance for the two remaining branches.

## 1.9.0-node.1 — VidStream-node

- Added independent library nodes with persistent identities, saved connection directories and a top-center library switcher. Browsers stream directly from the selected server, without a central media proxy or shared catalog.
- Added owner-only Nodes settings for names/reachable addresses, bounded identity checks, saved connection removal, availability and optional IPv4 LAN discovery. Discovery is an untrusted hint and never exchanges credentials/configuration or copies media.
- Retained offline connections, pinned checked identities, blocked known identity replacements and added a browser-only return link across origins, including locked sign-in screens.
- Scoped new session cookies/tokens to each instance so independent logins on the same hostname at different ports coexist. Existing sessions can migrate; malformed unrelated cookies no longer break authentication.
- Kept the native launcher stopped when a late child readiness message arrives during/after shutdown.
- Added portable manual-connection guidance, an optional Linux host-network Compose overlay, isolated multi-server browser tests and an optional actual-LAN smoke check. Automatic discovery remains dependent on OS/network/Docker multicast support.

## 1.8.0 — consolidated main

- Consolidated the already-merged development work and tested design checkpoint into main; node development stays separate.
- Added a visible Settings build/version, server address and owner/guest indicator, plus versioned stylesheet/script URLs. Existing browser tabs still need a reload after server updates.
- Fixed obsolete media links rendering authenticated owners as guests and hiding owner Settings categories. Guest private/missing links remain indistinguishable.
- Shared the non-node malformed-cookie and late-launcher-readiness fixes with main; node discovery, connections and scoped node sessions remain separate.
- Compared main, Dev and Design using the same generated-media browser checks; gallery/player geometry remains unchanged.

## 1.8.0-design.1 — VidStream-Design-Test-1

- Recorded the permanent self-hosted product direction: downloadable software serving the user's own locally available media.
- Added theme-aware sign-in polish, keyboard focus handling, real loading/error/retry feedback and a compact dismissible welcome notice without a blocking splash screen.
- Added browser-local first-visit/fresh-login state. Successful sign-in or owner setup rearms the experience; an authenticated reload/browser reopening does not. Empty/error responses retain the first media entrance for a later usable batch.
- Replaced repeated tile insertion animations with a bounded first-visible-batch entrance (up to 18 tiles, at most 600 ms total). Reduced motion, Data saver and Subtle/Off effects skip decoration. No new dependencies, grid spacing changes, or player size changes.
- Added isolated lifecycle and Chromium checks. Multi-node library switching remains deferred.

## 1.8.0-dev.1 — VidStream-Dev-Test-1

- Restored the larger 90% viewport player while retaining blur, native controls, background scrolling and layered navigation.
- Added permanent media IDs, SQLite catalog paging, content/recipe separation, conservative move matching and verified manual relinking. Migration creates pre-schema-3 backups; older code needs a restored pre-migration database.
- Staged imports show basic records/posters first; preview/analysis failures retain working media. Offline/missing sources retain their identities and history.
- Added durable work status and Browse/Balanced/Process presets, a bounded foreground identity/poster lane, and one heavy operation at a time.
- Added compatibility playback copies, five-second enhancement samples, synchronized comparison, recipes, output verification/provenance, active-version approval, confirmed publication to the source library, external original archives, restore and interrupted-publication recovery.
- Made SDR/8-bit/CFR/AAC output policy explicit; unsupported HDR/high-depth/anamorphic enhancement is refused. Space admission uses a conservative working estimate.
- Replaced gallery-sized SVG outlines with tile-local borders, released offscreen media sources/observers, batched tile insertion and added per-device effects and diagnostics. Active-preview settings remain user-controlled.
- Added recent/unfinished/less-seen sorting, saved filters, pinned actions, per-item artist labels, storage accounting, consistent catalog snapshots and explicit raw-event retention.
- Added a lightweight experimental native launcher and committed isolated Chromium regression checks to CI. Physical-device performance and cross-platform packaging remain separate validation work.

## 1.7.0

- Media-shaped viewer cards fit the source resolution and aspect ratio, reserve toolbar/stats space, and resize when enhanced media or viewport dimensions change.
- Settings and View options use category screens with Back, Escape, outside-click and browser Back/Forward navigation through individual levels. Choosing a setting keeps its section open.
- Zero gallery gap, outer padding and tile corner radius with artist outlines off; optional outlines retain only a 1 px seam. Fixed zero-gap masonry measurements.
- Hardware settings distinguish OS/VM RAM, container ceiling and quota/affinity-constrained CPU capacity, with allocation and GPU guidance. Resource defaults are unchanged.
- Recorded the user's requirement to explain every user-facing terminal command in AGENTS.md.

## 1.6.0

- Reworked the media viewer into a centered 90% browser-sized player so the blurred, scrollable gallery remains visible around it.
- Added a device-local 0–30 px viewer blur control under Settings → View.
- Added optional live “Stats for nerds” playback telemetry in the existing bottom dashboard dock, including source and viewport resolution, measured presented FPS, dropped frames, buffer, playback state, codecs, and original/enhanced source.
- Added a playback-speed selector, viewer settings shortcut, contained info/edit panels, keyboard focus handling, and prompt release of closed media.
- Backdrop clicks still close the viewer, while scrolling over the backdrop moves the gallery without interrupting playback.

## 1.5.0

- Dashboard library treemap, sized by storage or file count, with artist drilldown and an all-files nested view.
- Optional fine per-tile artist borders, hover/focus highlighting, and reusable shuffled colors without adding gallery gaps.
- All-media artist sorting clears gallery filters and keeps artists together regardless of favorites or creation dates.
- Authenticated, paginated map catalog with refresh detection when the index changes.

## 1.4.0

- Web-managed enhancement runtime/model installation, server enable/suspend switch and confirmed library batches; verified native Apple GPU support.
- Resumable clean-library exports, checked manifests, untouched originals and archived superseded exports.
- Locked first-time owner setup with salted passphrase hashing; functional logout, persistent whole-library access control and retained LDAP support.
- Live scoped CPU/RAM/GPU/VRAM/storage/network dashboard with persistent observed byte totals and native macOS telemetry.
- Compact translucent selected controls, grouped View options, tabbed Settings and device-local playback preferences.


## 1.2.0

- Durable SQLite favorites, pins, bookmarks, visibility, import dates, and revision history, separated from rebuildable previews.
- Full-frame responsive media, touch zoom/pan, stable toolbar and sliding information/edit panels.
- Fixed Debian/ImageMagick 6 photo metadata scanning (`identify` did not support `-auto-orient`).
- Extended ExifTool metadata, protected admin-only paths/GPS/history, compact glass footer, and reduced background flicker/load.
- Native-FPS preview rebuild and browser cache invalidation; original preview source and pause/resume controls.
- Ten YOLOv8/YOLO11 detection presets with pinned Hugging Face downloads and offline placement help.
- Beta photo crop/resize and video crop/trim with archived originals and revision manifests.
- Node 22.13+ required. Docker adds a persistent stream-data volume; retain it across updates.


## 1.1.1

- Fixed the startup restart loop by making `main()` asynchronous so its caller can handle rejected startup errors with `.catch()`.
- Added a regression test that launches the real server, checks `/health`, and verifies clean shutdown.

## 1.1.0 (GitHub-ready iteration)

- Preserved the lightweight, dependency-free Node.js gallery instead of replacing it with a heavyweight library manager.
- Video preview encoding can reach 60 FPS when the original has at least 60 FPS (`VIDEO_PREVIEW_FPS`, default 60). A 24 FPS source remains 24 FPS instead of duplicating frames.
- Configurable simultaneous gallery preview decoder limit (4–64, default 8), with hovered videos prioritized, and playback paused when the page is hidden or a lightbox is open.
- Per-video expand button, global normal/2× video sizing option, and continuous tile-width slider. Preferences live in browser local storage.
- Creator origin labels, colored tile outline, creator filter and grouped display by top-level folder; nested folders remain available as albums.
- Created/imported date filters and minimum short-edge resolution filtering (720p+, 1080p+, 4K+).
- Fixed on-screen photo/video/unsupported/unreadable counts with last-scan duration. The HTTP server starts immediately and scans in the background, so a slow NAS does not block cached-media browsing.
- Admin-only library audit dashboard: charts, per-creator and format breakdowns, recent scan history, unsupported/error list, and paged inventory.
- Safety: unreadable NAS mounts do not purge existing indexed files; admin restriction for manual rescan; guest-safe album/object metadata; health endpoint avoids disclosing private counts.
- Optional local AI model download/selection on the audit dashboard; CPU/RAM/GPU detection inside container; optional NVIDIA passthrough Compose overlay. Defaults to a lean non-AI image.
- Added automated tests, CI workflow, safer Git ignore patterns, and deployment/security documentation.

**Verification:** Node test suite and source syntax checks run locally, and a real 60 FPS source was transcoded to a 60 FPS preview. HTML interaction was tested in Chromium with API responses sourced from a running sample server. A complete Docker build, real GPU inference, live Synology LDAP, and real NAS deployment still need validation on the target machine.
