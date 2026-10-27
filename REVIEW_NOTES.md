# Stream 1.1.0 — code-review handoff

## Intent and architectural constraint
This is a fast, readily accessible photo/video viewer, not a full-time NAS uptime or Google Photos replacement. Continue from the lightweight Node.js/DOM/JSON implementation unless actual measurements justify replacement. Preplaying video tiles are the primary differentiator.

## Confirmed in this revision
- Native-60-FPS **input** generated a 60-FPS `.mp4` preview (verified by `ffprobe`), instead of the former hardcoded 15 FPS. Below-60-FPS inputs retain their native frame-rate ceiling. This is encoding FPS, not proof that every client paints 60 screen frames per second.
- Real media sample with two nested creator folders: 2 photos, 1 video, 1 unsupported file, and correct API grouping.
- Regression tests cover creator grouping, date/resolution filtering, guest metadata boundaries, admin-only rescan/dashboard, missing NAS mount preserving index, and AI preset validation.
- Chromium frontend smoke test with API responses captured from a live sample server: group headings, video expand control, fixed footer, and dashboard all rendered without uncaught browser JavaScript errors.
- Git excludes default `/media/` mount, credentials, cache, and rclone configuration.

## Fixed security/reliability issues
- Unauthorized guests can no longer invoke a manual rescan or read private album/object summaries.
- `/health` no longer exposes the library size to anonymous visitors.
- A failed directory read does not delete all cached/indexed assets beneath that folder.
- Cached derivatives now send `Cache-Control: private` rather than shared-CDN-public caching.
- Album dropdowns no longer interpolate filesystem names into raw HTML.

## Open validation tasks (do not claim these have passed)
1. Build the whole Docker image on Linux ARM and x86, with and without the AI stack.
2. Install a YOLO model through the live admin dashboard; verify actual inference and container memory use.
3. Test CUDA-enabled PyTorch and NVIDIA GPU passthrough on the target host. ROCm/AMD, Jetson and macOS Metal are not configured.
4. Connect to real SMB and Synology LDAP installations, and try real iPhone HEIC/HEIF files.
5. Benchmark actual compositor/frame cadence, video decoder contention, multiple mobile clients, network bandwidth, and power usage. The current cap of simultaneous previews is adjustable from 4 to 64.
6. Test large photo/video libraries. Queries still sort the in-memory JSON index; millions of indexed files are not benchmarked.
7. Verify all authentication, streaming, and cache behaviors in the final reverse proxy before publishing media to the internet.

## Design boundaries
- A timestamp from the internet posting platform cannot generally be extracted from downloaded video. The UI offers file created/taken date and Stream-import date instead.
- Reading host syslogs is deliberately not implemented. The dashboard uses scan history and application error records; Docker logs are available to host administrators.
- No automatic download of large weights or dependency bundles happens during normal browsing. Download/model changes require administrator action.
- The browser's viewport/layout scheduler controls actual display FPS; 60 FPS is a measured target, not a guaranteed setting.
