# Changelog

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
