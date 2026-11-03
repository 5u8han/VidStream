# Active branches and tested differences

Only **main** and **VidStream-node** are active. **Main 1.10.0 is the official release**, now including the reviewed node library switching as well as the completed catalog, player and design work. The node work was merged at the user's explicit request. VidStream-node remains for isolated future node experiments; it is not required to use Nodes. The histories of the former Dev/Design branches and the merged node work remain preserved.

Main 1.10.0 simplifies Settings and View options and removes video enhancement processing. Historical media, outputs, database rows and backups remain intact. Use main for the current product; older experimental checkpoints may retain retired controls.

## Why the branches looked the same

The comparison used archived source snapshots and generated 36 photos plus 17 videos per run. Each snapshot used separate temporary media, data/cache and a local test server. Personal media, `.env`, Docker volumes and the running deployment were not changed.

| Compared snapshot | Version | Actual difference | Browser checks |
| --- | --- | --- | --- |
| Former main `97672d8` | 1.8.0-dev.1 | Catalog, player, enhancement and browsing checkpoint | 16 passed |
| Dev `f18cfd8` | 1.8.0-dev.1 | Exactly the same files/tree as former main; already merged | 16 passed |
| Design `4510872` | 1.8.0-design.1 | Login/loading/welcome polish; first visible tiles enter once | 26 passed |
| Node `303ff6f` | 1.9.0-node.1 | Includes design plus independent libraries, discovery and switching | Previously passed 17 node-specific checks plus the common browser suite |

All three non-node comparisons displayed all 53 generated media records, had zero browser script errors, zero gallery gap/padding/corner radius, the same six owner Settings categories, and a 1152 × 720 viewer in a 1280 × 800 viewport. The models, media-processing behavior, gallery layout and player size did not change between these snapshots.

Main and Dev shared the exact tree `4108933b88ec7c89bbcf4f88696fc3021db9c3fe`. They differed only in history because main had already merged Dev. Main/Dev replayed the old tile entrance on all 53 tiles when reopening an authenticated browser. Design limits entrances to a first visible batch, retains its browser-local seen state, and does not replay the welcome/entrance on an authenticated reopen. Ordinary browsing therefore deliberately looks very similar.

Main includes the design behavior and, starting with 1.9.0, the node functionality. The former Dev/Design branches are retired after ancestry verification. The table above describes historical checkpoints, not a current main-versus-node feature split.

The earlier consolidated main version `1.8.0` additionally passed 115 unit/integration tests and 28 generated-media browser checks, including visible build information and authenticated obsolete-link behavior. These are same-host Chromium tests, not physical frame-rate or large-NAS throughput measurements.

## Why Nodes was missing

In the reported case, a forced browser reload made Nodes appear. Rebuilding a container does not reload JavaScript already running in an open tab. The container inspected during diagnosis was already a node build with its node assets present.

Settings now displays the actual loaded version, browser origin, owner/guest state and whether Nodes is included. Asset URLs carry the application version on a fresh page load. A separate confirmed bug was also fixed: opening an obsolete media URL previously returned a page shell with the owner flag missing, even for an authenticated owner. The fixed shell preserves the role without exposing unavailable/private media.

Node configuration remains owner-only. Main shows an explanatory Nodes entry for guest views instead of silently omitting the category; this does not grant access to its private APIs or directory.

One inspected deployment was built from a downloaded ZIP folder rather than this Git checkout. A Git update in one folder does not update source in another folder. Build/recreate from the same deployment folder/project you intend to run. Keep the existing media mounts, `.env`, and persistent volume names when changing a deployment's source location; changing the Compose project name can select different volumes.

## Update an existing Git-based deployment

Run inside the Git checkout used to build that deployment. Save local source edits before switching. Do not replace `.env` or remove persistent volumes. **Before the first 1.9 Docker recreation, retain your existing mounts as described below**: the media bind is now opt-in, and a new named originals volume is the default only for new installations.

```sh
git fetch origin --prune
git switch main
git pull --ff-only
docker compose up -d --build
```

- `git fetch origin --prune` updates Git history/remote references and removes stale remote-tracking references for deleted branches. It does not delete local branches, source edits, media, configuration or Docker data.
- `git switch main` selects the consolidated main source and updates tracked files; conflicting local edits are not discarded. It does not change ignored media/configuration or Docker volumes.
- `git pull --ff-only` updates that branch only if no merge is necessary; it does not reset local changes or delete media/data.
- `docker compose up -d --build` rebuilds and recreates this Compose project's application in the background. It uses the mounts in the selected Compose files and retains named volumes; retain old media/originals binds explicitly before this command. It does not update another folder's project or an already-open browser tab.

Then reload the gallery home page. On Mac, **⌘⇧R** forces a fresh reload; on Windows/Linux use **Ctrl⇧R**.

For node testing, replace the switch command above with:

```sh
git switch VidStream-node
```

`git switch VidStream-node` selects the separately retained node experiment branch; it may still identify itself as an older node checkpoint. Ordinary deployments should stay on main, which already includes Nodes. The fetch, fast-forward pull, Docker rebuild and browser reload steps have the effects described above. Use the [node setup guide](NODES.md) for current official behavior.

Verify both the checkout and container:

```sh
git branch --show-current
docker compose exec stream node -p "require('./package.json').version"
```

`git branch --show-current` reports the local checkout's branch. `docker compose exec stream node -p "require('./package.json').version"` reads the version from the running container without changing files. Settings shows the browser's currently loaded version; it should agree after a reload. Git branch, running container and browser page are three separate states.

Other machines may retain local Dev/Design branch names after a fetch. After saving local edits and checking those branches contain no private/unpushed commits, use:

```sh
git switch main
git branch -d VidStream-Dev-Test-1 VidStream-Design-Test-1
```

`git switch main` moves off a branch before deleting its local name. `git branch -d` removes only the two specified local branch references and refuses unmerged work; it does not delete commits retained by main, working media, `.env`, or Docker volumes. Do not force-delete a branch containing unmerged personal changes.

## Retain existing storage before rebuilding

The 1.9 base Compose file no longer binds `./media` automatically. New installations explicitly enable the commented media bind and set `STREAM_MEDIA_PATH` to an existing absolute folder; no repository media skeleton or file copying is needed. Keep an existing deployment's exact media source/target mapping in its local Compose override so relative paths and saved item identities remain consistent. A missing mount may show an empty/offline collection; do not reset or delete the catalog to fix it.

New installations use `stream-originals:/app/originals`. **If this deployment previously bound `./originals:/app/originals`, retain that host bind explicitly in the same local override**; resolve it to the old absolute folder if the source checkout moves. The old archive is not migrated into the new volume automatically. Existing generated originals and recovery journals must remain at the same container path. Keep that folder and its backup. Existing external media/originals overrides continue to take precedence over the base mount at the same target.

For example, an existing local override can retain both mounts. Replace the two example source paths with the existing folders, not new empty locations:

```yaml
services:
  stream:
    volumes:
      - type: bind
        source: /absolute/existing/media
        target: /media/original
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /absolute/existing/originals
        target: /app/originals
        bind:
          create_host_path: false
```

This is configuration, not a terminal command. A read-only media mount supports browsing; Quick edit requires an explicitly writable mount. Enhancement/publication controls are retired in 1.10.0, while their historical files remain preserved. Keep a local override out of Git; never commit real host paths or credentials. Use it in the same Compose file list/project as before. A local `.env` with `COMPOSE_FILE` already set continues to select that list; otherwise explicitly include the local override when recreating the app. Retain the existing Compose project/volume names for `stream-data` and `stream-cache`, or deliberately declare those volumes external by their existing names.

The new published HTTP default is 80 while container HTTP remains 4000. Set `STREAM_HTTP_PORT=4000` to retain an old public `:4000` address, or choose another available host port such as 8080; these are `.env` settings. To use the new plain `http://hostname/` address, ensure that hostname resolves and port 80 is free. A real HTTPS proxy is needed for 443. Update `URL`, **Settings → Nodes → This library address** and saved peer addresses when changing public URLs; stored node settings take precedence over environment defaults. Reloading a page under a different origin can require sign-in and counts as a new browser-local first visit.
