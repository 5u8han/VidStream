# Active branches and tested differences

Only **main** and **VidStream-node** are active. Main contains the completed single-library development and design work. Node development remains separate. Removing old branch references does not remove their commits: the reviewed changes remain in main's history.

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

Main now includes the design behavior. The former Dev/Design branches are retired after ancestry verification. Node functionality is **not** merged into main.

The consolidated main version `1.8.0` additionally passed 115 unit/integration tests and 28 generated-media browser checks, including visible build information and authenticated obsolete-link behavior. These are same-host Chromium tests, not physical frame-rate or large-NAS throughput measurements.

## Why Nodes was missing

In the reported case, a forced browser reload made Nodes appear. Rebuilding a container does not reload JavaScript already running in an open tab. The container inspected during diagnosis was already a node build with its node assets present.

Settings now displays the actual loaded version, browser origin, owner/guest state and whether Nodes is included. Asset URLs carry the application version on a fresh page load. A separate confirmed bug was also fixed: opening an obsolete media URL previously returned a page shell with the owner flag missing, even for an authenticated owner. The fixed shell preserves the role without exposing unavailable/private media.

Node configuration remains owner-only. The node branch shows an explanatory Nodes entry for guest views instead of silently omitting the category; this does not grant access to its private APIs or directory.

One inspected deployment was built from a downloaded ZIP folder rather than this Git checkout. A Git update in one folder does not update source in another folder. Build/recreate from the same deployment folder/project you intend to run. Keep the existing media mounts, `.env`, and persistent volume names when changing a deployment's source location; changing the Compose project name can select different volumes.

## Update an existing Git-based deployment

Run inside the Git checkout used to build that deployment. Save local source edits before switching. Do not replace `.env` or remove persistent volumes.

```sh
git fetch origin --prune
git switch main
git pull --ff-only
docker compose up -d --build
```

- `git fetch origin --prune` updates Git history/remote references and removes stale remote-tracking references for deleted branches. It does not delete local branches, source edits, media, configuration or Docker data.
- `git switch main` selects the consolidated main source and updates tracked files; conflicting local edits are not discarded. It does not change ignored media/configuration or Docker volumes.
- `git pull --ff-only` updates that branch only if no merge is necessary; it does not reset local changes or delete media/data.
- `docker compose up -d --build` rebuilds and recreates this Compose project's application in the background. Configured media mounts and named data/cache volumes are retained. It does not update another folder's project or an already-open browser tab.

Then reload the gallery home page. On Mac, **⌘⇧R** forces a fresh reload; on Windows/Linux use **Ctrl⇧R**.

For node testing, replace the switch command above with:

```sh
git switch VidStream-node
```

`git switch VidStream-node` selects the separate node implementation. The fetch, fast-forward pull, Docker rebuild and browser reload steps have the same effects described above. Use the [node setup guide](https://github.com/5u8han/VidStream/blob/VidStream-node/docs/NODES.md) for that branch.

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
