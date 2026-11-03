# Catalog and processing changes included in main

Current release: **main 1.10.0**. This document records earlier checkpoints. Video enhancement/processing instructions below are historical and retired; use the current [README](../README.md) for operation. Settings and View options now expose everyday controls directly instead of category drilldowns.

The former `VidStream-Dev-Test-1` checkpoint (`f18cfd8`, version `1.8.0-dev.1`) was merged into main. Official main is now version `1.9.0` and also includes the design and reviewed node-library work. Main is now the only branch; all reviewed node work is included. The old development branch has been retired. The original pre-migration checkpoint was main v1.7.0, commit `479b1da`.

These catalog, browsing and processing changes are included in main. The larger v1.6 player is restored: the card occupies 90% of browser width and height, fits media inside it, and keeps the blurred gallery scrollable around it.

## Before testing with existing data

Stop the current instance cleanly and retain a separate backup of its complete data volume/folder, media and configuration. Keep cache too if you want the exact old previews. Test against a copy of durable state first. Never run old and new instances against the same data or enhancement work folders.

On first startup this branch upgrades SQLite to **schema 3**. It creates a consistent pre-migration SQLite snapshot under `DATA_DIR/migration-backups` and copies the legacy JSON catalog there before import. The SQLite catalog then becomes authoritative. Cache loss no longer removes the catalog, favorites or history.

**Rollback requires restoring the pre-migration data with the application stopped.** v1.7 refuses schema 3. Merely switching branches will not downgrade the database; do not delete the database to bypass that check. Restore the old complete backup for the most predictable rollback. Changes made after the checkpoint are not present in that older backup. Keep the dev data separately if you want to return to it.

## Use the branch

Run these inside the existing repository after preserving data and any local source/configuration edits. Before recreating a pre-1.9 deployment, retain its existing media and originals host binds explicitly; see the [storage upgrade guide](BRANCHES.md#retain-existing-storage-before-rebuilding). The new base file has no active media bind and new installs use a named originals volume.

```sh
git fetch origin
git switch main
git pull --ff-only
docker compose up -d --build
```

- `git fetch origin` downloads repository history and branch pointers; it does not replace working files or media.
- `git switch main` selects the consolidated main branch. Git refuses conflicting local edits; resolve those deliberately rather than forcing the switch.
- `git pull --ff-only` updates that branch only when it can advance without creating a merge.
- `docker compose up -d --build` rebuilds and starts/recreates the application in the background using the selected Compose files. It retains named volumes and starts the schema migration when the app opens an old database. Keep your local media/originals override included; implicit old host binds are no longer part of the base file.

Do not remove Docker volumes to upgrade. Application files, media and durable state are separate things.

## Browsing and playback

- Artist borders are painted locally on tiles rather than through an SVG spanning the entire gallery. Borders remain individual, including edges between tiles from the same artist.
- Offscreen previews pause, retain their position briefly, then release media sources after a two-second grace period. Filter resets clear media and observer references. This preserves the selected simultaneous-preview cap and render-all option.
- Effects Off/Subtle/Full, blur, data saver and preview limits are local to the browser. Ambient animation pauses during scrolling/foreground playback to reduce competing rendering work.
- View options includes Playback diagnostics: a short visible-tab sample of page scheduling, presented video FPS, retained preview sources and available browser memory, plus passive first-visible-thumbnail, first-player-frame and recent catalog response timings. Page callback FPS is not the physical display refresh rate; a 24 FPS source remains 24 FPS without interpolation.
- Recent opens, Continue watching and Less seen use intentional viewing activity. Grid autoplay is not a viewer open. Saved filters and pinned actions stay on the current browser. Continue watching seeks to the recorded position.
- Native playback remains first choice. If the browser rejects a source, VidStream can prepare a cached H.264/AAC MP4. Compatible H.264 video is remuxed instead of re-encoded where possible. This is distinct from AI enhancement. HDR is not silently tone-mapped. Preparation may wait behind the current heavy job; pause that job if needed.

No universal 60 FPS claim is made. Test the original problem in Brave/Chrome on the actual library, collect diagnostics with the same settings, and compare. Headless Chromium regression checks cannot establish performance on a physical i9, iPad or Apple GPU.

## Catalog and import behavior

Every logical item has a permanent media ID. Link IDs stay compatible through aliases. Content versions are separate from basic/preview/analysis recipes, so a detection-model or preview-size change does not invalidate a completed enhancement of unchanged source bytes.

The scanner first exposes basic records and posters, then creates previews and runs optional analysis. Existing derivatives are retained until replacements succeed. Missing sources and unreadable folders are retained as missing/offline; reconciliation does not erase their history.

An absent original can be matched to an unambiguous new location by its content hash. Identical copies that are still present remain separate. Ambiguous candidates are not merged. Maintenance → Relink moved media accepts the permanent ID from Info and an unclaimed relative path with identical bytes; it refuses another item's path/history. Artist display labels apply to an individual item without renaming its folders and are searchable.

SQL handles catalog paging/filtering/order; existing routes still use an in-memory record map. This is an incremental migration, not a claim of unlimited catalog capacity or a full-text-search index. Source hashes normally reuse unchanged size/mtime; a forced reconciliation rechecks bytes even when external tools preserve both after editing.

## Background work and hardware

Maintenance shows active/queued/recent interrupted work and the last scan. Browse comfortably, Balanced and Process faster control background concurrency. One additional light identity/poster task can run when a background job occupies the base permits. Heavy playback preparation, enhancement, editing, publication and export do not overlap through the coordinator.

Presets cannot grant RAM, CPU cores or GPU access. Docker/VM limits and drivers still control hardware visibility; see [Hardware](HARDWARE.md). Runtime/model installation retains its own installation progress. Work owners resume/retry their own interrupted tasks: reconcile imports, resume saved enhancement jobs, or resume exports.

## Enhance, review, publish, restore

1. Enable enhancement and install the supported tools/models from Settings → Enhancement.
2. Open a video → Enhance video. Choose the recipe and a sample start time. Render a five-second sample, bounded by the end of the source.
3. Compare original/result. Original controls drive both views and original audio is used. Samples cannot become the full-media default or be published.
4. Estimate a full job after the sample, then Queue full video. Runtime estimates include queue/startup effects and are approximate. Space estimates are conservative working estimates, not reservations against unrelated processes consuming disk.
5. Review the full result. Approve & use by default selects a separate enhanced variant and preserves the original source.
6. Optionally confirm Publish & archive original. This writes the enhanced MP4 into the source library and retains a checksum-verified original and recovery journal outside media. File extension can change to MP4. Existing unrelated destinations are refused. Native archive location defaults to `./originals/original`; new Compose installs use `/app/originals/original` in the separate persistent `stream-originals` volume. Existing host-bound originals must keep their original bind explicitly so old archives remain reachable; no automatic archive migration occurs. Use `ORIGINALS_DIR` for another location outside the media tree.
7. Restore archived original checks both current and archived bytes before restoring the prior source. Maintenance → Recover interrupted publication conservatively rolls unfinished journaled publication/restore operations back to verified originals. Unknown/changed files remain for manual review. No recovery action deletes the archive.

Publication requires writable media and archive storage. Extension-changing publication uses atomic no-overwrite hard links on the media filesystem; if that filesystem does not support the operation it fails safely, retaining its journal/archive. Ordinary same-path replacement uses an atomic rename after verification. Files changed externally during an operation are treated conservatively, but concurrent external writers should still be stopped.

The supported processing output is **SDR H.264, 8-bit yuv420p, constant frame rate and AAC audio**. Smoothing targets 60 FPS; resolution-only jobs keep the nominal source rate. All source audio streams are mapped to AAC. Subtitles are not retained. Standard metadata is mapped where MP4 supports it; this does not promise preservation of every tag, chapter, timestamp or edit list. HDR, high-bit-depth and anamorphic enhancement is refused until a deliberate conversion policy exists. Rotation is applied by the decoder; VFR timing becomes CFR. Always compare results before publishing.

Jobs retain source snapshots, checksum-verified frame/segment checkpoints, final checksums, technical verification and processing provenance. Changing machines resumes completed compatible work; unfinished work can be regenerated. A corrupt completed result cannot be approved/published. Clean completed checkpoints removes only reproducible intermediate frames/segments after verifying the final output. It retains the source snapshot, manifest and result; incomplete jobs retain their resumable work. There is no automatic deletion policy for incomplete jobs.

Power loss, damaged storage and deletion of volumes cannot be made lossless by application code. Maintain backups; the current unfinished segment may need to run again.

## Storage, backup, activity and moving machines

Maintenance measures indexed original media, cache, models/tools, source snapshots/checkpoints, final outputs, archives and free space on the data filesystem. It excludes symlinks and does not discover unindexed source files. Different filesystems can have different free-space limits.

Create catalog backup uses SQLite's backup facility when available, otherwise a completed consistent `VACUUM INTO` snapshot. Download it from the resulting link. This backs up the catalog, preferences, job records and activity, **not** media, source snapshots, checkpoints, model binaries, security configuration or archives. Copy complete stopped data folders for a full migration. See [SQLite's backup guarantees](https://sqlite.org/lang_vacuum.html#vacuuminto).

Raw activity retention is an explicit action with confirmation, not automatic scheduled pruning. It removes events older than the chosen number of days while retaining cumulative counts and last viewing positions. No old raw events are removed merely by upgrading.

To transfer work, stop the old instance cleanly, copy complete data plus source media and the separate originals archive, configure the new paths, install/verify tools for the destination OS, and start only the new instance. Cache can be copied or rebuilt; copying it also retains detection weights. SQLite stays on local storage even when sources live on a NAS. Queued enhancement work resumes, while explicitly paused/error jobs require Resume. A completed source snapshot permits an existing job to resume while its source NAS is offline.

## Native launcher and development checks

The experimental launcher uses the same server and browser UI. It checks installed dependencies and offers paths, start/stop, logs and opening the gallery. It does not install dependencies, convert Docker volumes or provide a signed desktop installer. Stop Docker before starting native mode against the same library/state.

`npm run launcher` opens the local native launcher; starting its server uses the folders you select. Stop server shuts down the child and retains media/configuration/data. The launcher binds to localhost; LAN access for the media server is an explicit checkbox.

For development verification:

```sh
npm ci --ignore-scripts
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

- `npm ci --ignore-scripts` installs exact development dependencies from the lockfile, replacing `node_modules`. It does not touch media or application state and runs no dependency install scripts. Production serving needs no npm packages.
- `npm run check` validates JavaScript syntax, without starting the server.
- `npm test` runs application and real media-tool tests against generated temporary files. Each test cleans its own temporary data; it does not use the personal library.
- `npx playwright install chromium` downloads the test browser into Playwright's browser cache. It does not replace your installed Chrome/Brave.
- `npm run test:browser` starts an isolated temporary server, generates a mixed test library, exercises actual browser interactions and cleans only its generated temporary files after shutting down.

CI installs test dependencies, media tools and Chromium, then runs the same suites. The browser checks follow [Playwright's CI setup](https://playwright.dev/docs/ci-intro). Native hardware/model inference, physical Safari/iOS behavior, long NAS outages and large real-library frame delivery still require device testing. Adaptive streaming, distributed workers, a second frontend and desktop packaging are intentionally outside this development pass. The dedicated security review remains a later workstream; existing access checks remain in place.
