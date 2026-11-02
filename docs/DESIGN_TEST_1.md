# Design behavior included in main

The former **VidStream-Design-Test-1** checkpoint (`4510872`, version `1.8.0-design.1`) is included in official **main 1.9.0**, together with the reviewed node work. The separate design branch has been retired. VidStream-node remains available for isolated future experiments.

## Permanent direction

VidStream remains software people clone/download and run on their own machines, serving locally available media for easy viewing/sharing. It must not become a centrally operated service accepting media uploads into our cloud. Future plans should be checked against this goal.

The original design checkpoint did not create/discover/connect nodes. Later node work is now included in official main; see [Nodes](NODES.md) for independent library switching. Neither design effects nor node switching combines disks, credentials or catalogs.

## The first experience

The existing circular mark, semantic themes and dense gallery are retained. Sign-in has a clearer hierarchy and larger inputs. Loading uses actual request state; a failure offers **Try again**. A small welcome notice floats above the summary without moving gallery rows; dismiss it or open media to remove it.

The first visible batch gets a short fade/8 px rise: at most 18 participants, a 360 ms entrance and stagger capped at 240 ms. No new animation loop, whole-grid morph, persistent layer promotion, per-tile blur or animation dependency is added. Controls and playback are immediately usable. Filtering and pagination no longer replay the old unconditional tile insertion effect.

| Situation | Behavior |
| --- | --- |
| New browser profile on this server | Sign-in/welcome entrance; first usable tile batch enters once |
| Successful sign-in or owner setup | Welcome and first media entrance are rearmed before reload |
| Incorrect credentials / sign-out alone | Does not rearm or consume the gallery entrance |
| Reload, new tab, browser close/reopen while signed in | Saved markers prevent replay |
| Filtering, sorting, resizing or pagination | Does not rearm the entrance |
| Failed request or empty library | First media entrance remains pending until a nonempty batch arrives |
| Reduced motion, Data saver, Subtle/Off effects | Decoration is skipped; state and useful content still work |
| Cleared/private/blocked browser storage | May count as a new visit; blocked storage falls back to once per page |

This identifies a **browser profile and site origin**, not physical hardware. Another browser/profile, another server address, cleared site data or private browsing can count as a new visitor. No fingerprinting or device registry is added. Local storage keys begin `stream-entrance-v1:`; these are separate from media activity and synced viewing preferences.

## Use the consolidated main branch

From your existing VidStream checkout, save any local source edits before switching. Keep your media paths and `.env` in place. Before the first 1.9 Docker recreation, follow [storage upgrade steps](BRANCHES.md#retain-existing-storage-before-rebuilding): keep existing media/originals binds explicitly, because the base defaults changed.

```sh
git fetch origin
git switch main
git pull --ff-only
docker compose up -d --build
```

- `git fetch origin` downloads Git history and branch references; it does not alter working files, media, configuration or Docker data.
- `git switch main` selects the consolidated main branch and updates tracked source files. It leaves ignored media/configuration and Docker volumes in place and refuses conflicting local edits.
- `git pull --ff-only` updates the selected branch only if no merge is needed; it does not discard local changes or delete media/configuration/volumes.
- `docker compose up -d --build` rebuilds the application and starts/recreates it in the background using the selected Compose configuration. It retains named volumes; include your existing local media/originals override before running it. No volume removal command is needed.

To verify the selected source version:

```sh
git branch --show-current
docker compose exec stream node -p "require('./package.json').version"
```

`git branch --show-current` prints the active local branch. `docker compose exec stream node -p "require('./package.json').version"` reads the package version inside the running container without changing files; expect `1.9.0` on main. For native deployments, `node -p "require('./package.json').version"` reads the checkout's package version without starting the app or changing files. Rebuilding is required for an existing Docker container to use changed source files; reload the browser afterward.

Check a new browser profile, sign out/in, then reopen a still-authenticated browser. Try keyboard navigation, a narrow phone-sized window, all viewing themes and reduced motion. Generated test clips cannot establish physical-device playback performance on a large personal library.

## Research and validation

The Design chat's saved research informed this implementation: Motion's bounded effects/lifecycle/performance guidance, Fluent's semantic roles and hierarchy, and the component/workflow comparisons covering Flowframes, UI/UX Pro Max, Higgsfield, TypeUI, Astro, Skiper, beUI and Svelte. The research was applied to the existing plain JavaScript/CSS stack. No paid source, upstream component implementation, cloud model service or framework was copied/installed.

Validation on November 2, 2026: JavaScript syntax checks passed, all 111 unit/integration tests passed, and all 26 Chromium browser checks passed with no page errors. Browser checks include new/reopened profiles, successful and failed logins, logout/login, capped animation timing/cleanup, filter changes, reduced motion/effects off, live preference changes, short landscape sign-in/setup, loading failure/retry, desktop/mobile player sizing, navigation and the existing saved enhancement workflow. The app was visually reviewed using generated sample artwork. These are local native-server checks; this revision did not build a Docker image or establish frame rates on a large personal library.

For developers:

```sh
npm run check
npm test
npm run test:browser
```

`npm run check` parses project JavaScript for syntax errors. `npm test` runs the unit/integration suite with temporary fixture data. `npm run test:browser` starts an isolated local server and Chromium against generated media, checks design lifecycle plus existing player/navigation/enhancement behavior, then removes only its own temporary fixture directory. These commands do not read or modify your personal media, `.env` or Docker volumes. FFmpeg and the existing development Playwright installation/browser are required for browser checks.
