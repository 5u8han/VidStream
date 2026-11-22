# Your VidStream guide

Pick a folder, let the previews get ready, and browse. The controls below are
there when you need them. Your files stay on the storage attached to the
VidStream machine you opened.

Installing for the first time? Start with [Start-Here](STARTER.md). Looking
for a terminal command? Use the [command reference](COMMANDS.md).

## First visit

1. Open the address printed by Start-Here. On the host itself, local-only
   access usually opens at `http://127.0.0.1/`. With LAN access, use the host
   address you chose during setup.
2. Enter the one-time owner setup code from the launcher or server log.
   Choose a passphrase between 10 and 256 characters. On this installation,
   that passphrase is what you'll use the next time you sign in.
3. Let the first scan run. New items appear as their first processing stage
   finishes. Open Dashboard if you want to see the current files and progress.

An existing installation keeps its owner account with its persistent data.
If you configured an environment password or LDAP, use that sign-in. Keep
setup codes and logs private. [Access and privacy](../SECURITY.md)

The welcome and tile entrance run once in this browser after sign-in.
Opening a new tab while still signed in keeps the gallery ready to browse.
To turn off the animations, choose **Settings → Gallery → Appearance →
Animations and effects → Off**.

## The top bar

| Control | Use it for |
| --- | --- |
| Current folder name | Switch folders, scan one folder, or view its last scan result |
| Node | Open another saved VidStream machine |
| Search | Find filenames, folder names, artist labels, and available recognition tags |
| Settings | Change gallery filters and playback, edit host folders, or switch to indexing, storage, and account settings. On touchscreens, swipe left or right across a category. |
| Dashboard | Follow scans, inspect resources, repair files, and check storage |

In a single-root setup, album and artist selectors can appear when the
catalog has values to choose from. Folder collections and mounted folders
provide the primary navigation in larger setups.

## Your folders, your order

The scanner follows nested directories under the roots you choose. It
recognizes JPEG, PNG, GIF, WebP, HEIC/HEIF, TIFF and BMP photos, plus MP4,
M4V, MOV, WebM, MKV and AVI videos. A folder can also contain documents or
ZIP archives. Those files are skipped. Video playback depends on the codec
inside the file, so two MP4s can behave differently on the same device.

Open the current folder name at the top left and choose a folder or **All
media**. Start-Here's first selected mount opens on a new browser. VidStream
then remembers your choice. Refreshing the page restores the folder and the
gallery location from that tab. Refreshing an open photo or video restores
the viewer too. Closing it returns you to the saved gallery position.

Very deep gallery positions restore from a nearby page of catalog records.
Use **Start of folder** if you want to jump back to the beginning. Per-tab
position checkpoints clear on sign-out.

In a guided installation, open **Settings → Host & folders → Browse host** to pick a directory on the Docker machine. If the picker only shows your current library, choose **Allow a directory in the web folder picker** in Start-Here on the host. For a NAS or DAS with many collections, approve the parent media directory once, then pick its children in the browser. Only the folders you add become gallery libraries.

Move a folder up or down to set its position. **Save to compose.yaml** writes the host configuration. **Apply and restart** makes the new mounts available and briefly interrupts playback. Removing a mount from this list leaves its source files on disk. Start-Here also retains its terminal folder picker.
A **Node** keeps serving its selected library, and you can change its role
under **Settings → Nodes → Machine role**. [Folder setup](MOUNTED_FOLDERS.md)

For a manual single-root setup, **Settings → Host & folders** can name shortcuts
inside that root. Enter paths relative to the mounted media directory.
A shortcut filters the catalog. A Docker mount determines which host files
the app can access. [Folder shortcuts](FOLDERS.md)

## Make the grid feel right

Open **Settings → Gallery** to tune this browser’s layout, sorting and folder view.

| Option | What it does |
| --- | --- |
| Media size | Changes the tile size |
| Whole frame / Fill tiles | Shows the full frame or fills the tile by cropping |
| A video's resize control | Makes that individual preview larger |
| Randomly enlarge videos / Reshuffle | Adds a mixed-size arrangement across the grid |
| Browse by folder | Groups media by its actual folder. A slim divider shows each relative path. Choose a subfolder to include it and its descendants, or choose Parent folder to move up. |
| Sort order | Chooses newest, oldest, filename order, shuffle, and other available views |
| Favorites, Pinned, Bookmarks | Filters to the flags you saved |
| Faces, Pets, Text | Filters to available local recognition results |
| Dates and resolution | Filters by media/import dates, date range, or minimum resolution |
| Saved views | Saves the current filter and sort choices in this browser |
| Pin to toolbar | Adds a quick action such as shuffle, favorites, or preview pause |

The artist sort opens all media in artist order and clears other gallery
filters. **Recently opened**, **Continue watching**, and **Less-seen shuffle**
use recorded activity. In Continue watching, an opened video seeks to its
saved position.

Open a tile and use **Best**, **Pin**, or **Bookmark** in the viewer. To see
those picks again, open **Settings → Gallery** and select the matching filter. Search can
include extracted text and object tags
when those optional features have been enabled and processed.

For themes and visual effects, open **Settings → Gallery → Appearance**.
Reduced-motion preferences apply. Several visual and playback choices are
browser-specific, so your phone can have a different setup from your desktop.

## Preview a video before opening it

**Settings → Playback → Video previews → Preview source → Optimized** uses the server's
prepared clips. For a short video, the opening preview loops. For a video
longer than one minute, the preview plays the opening and then up to five
seconds at 1:00, 2:00, and every following minute. The badge shows the sample's
timestamp in the original video.

Later minute samples are generated when you view them. The first visit can
pause while a clip is prepared, then the host cache keeps it for reuse.
Original preview mode streams the source directly.

| Control | When to use it |
| --- | --- |
| Autoplay previews | Start or pause gallery motion |
| Concurrent previews | Choose how many visible videos can play together |
| Lightweight gallery | Use smaller existing posters and fewer visual effects |
| Data saver | Reduce autoplay and delay image loading. The page reloads to apply it. |
| Browser preview memory | Keep recent optimized clips in the current tab, with Off through 2 GiB choices |
| Check playback smoothness | Measure what the current browser is doing |

New browsers start with a 1 GiB preview-memory budget. Previously enabled
memory caching also starts at 1 GiB, while an existing Off preference stays
off. The budget fills as you browse. Browser memory is on the device you're
watching from. Closing the tab releases it. The server has a separate cache
on its own SSD or optional RAM storage. [Cache guide](PORTABLE_CACHE.md)

Optimized clips can play at the source frame rate up to 60 fps. The server
prepares the media, and the viewing device decodes and displays it. Network,
storage, and decoder load can affect playback. The gallery releases distant
media elements as you scroll. [Performance guide](PERFORMANCE.md)

## Open the full viewer

Select a tile to open a photo or video. **Previous** and **Next** switch items.
**Escape** closes the viewer. **Play slideshow** advances photos and continues
after a video ends. Double-click to zoom or pinch on touch screens, then drag
to pan.

For a video, **←** and **→**, or **−10s** and **+10s**, seek within the current
file. The outside chevrons switch media. Use the player's audio, seeking,
and playback-speed controls as usual. VidStream saves the playback position
with its server catalog, independently of viewing-history recording.

The full player tries the original source. If the browser rejects it,
VidStream can prepare a compatible copy in the host cache. A failed copy
appears in **Dashboard → Media repairs** for review and retry.

Open **Info** for metadata, technical details, and the permanent media ID.
**Stats for nerds** shows available resolution, frame, buffering, and playback
source details. You can enable it by default and set the viewer's background
blur under **Settings → Playback → Video player**.

**Download original** retrieves the source when original downloads are enabled.
Media addresses use the owner session for that instance.

## Scan at your own pace

An empty gallery offers **Scan library now**. The folder menu has **Scan**
buttons for individual folders. Its **ⓘ** control shows the last scan time,
outcome, and counts.

**Dashboard → Scan activity** shows the current phase, worker limits, active
paths, elapsed times, and recent operations. **Pause indexing** lets current
operations finish and stops starting new scan operations. **Resume indexing**
continues that scan while the app remains running. A container restart ends
the live scan and retains completed work already saved to the catalog and
cache. Server logs are at the bottom of Dashboard.

Open **Settings → Indexing** to choose the behavior for this server.

| Setting | Choices and timing |
| --- | --- |
| When VidStream starts | Scan media, open the saved catalog, or follow deployment configuration. Applies on the next launch. |
| Watch folders for changes | On, Off, or follow deployment configuration. Applies while running after startup scanning finishes. |
| Scheduled rescans | Off, a preset interval, a custom interval, or follow deployment configuration |

Each saved choice lives in the server database. **Use deployment setting**
returns that control to the value supplied by Compose or the environment.
Turning watching on may walk the media folders to register watchers. With
watching and scheduled scans off, start a scan after adding or changing media.

A completed catalog opens after an update when its media roots still match.
New mounts or an older scan signature that cannot be verified can require a
reconciliation pass. Matching files can reuse prior completed processing.
**Refresh metadata & previews** under **Settings → Playback** forces a more expensive refresh.
[Large-library details](PERFORMANCE.md)

## Fix the files that need attention

**Dashboard → Media repairs** lists failed imports and compatible-copy jobs. To work on a file immediately, enter its path relative to the media mount, including its top-level folder name. On an indexed item, open the player’s **Info** panel to start work on that file directly. The repair worker can run during a scan or while indexing is paused. Requests for a file already being written wait for that file’s active stage. Other folders can continue scanning.
Select a file to open **Repair details**. Use Back, Escape, or your browser's
Back action to return through the pages. General storage and app notifications
stay in Dashboard's Notifications panel.

| Action | What happens |
| --- | --- |
| Repair media | Rechecks one supported source and rebuilds its metadata and cached derivatives |
| Retry playback copy | Retries a failed compatible-copy job |
| Open media | Opens the indexed item when it is available |
| Copy path | Copies the path relative to the library mount |
| Export recovery list | Downloads a list of unresolved original files for recovery elsewhere |

Repair results stay with the issue. A source that still cannot be read or
decoded reports the failure. You can export those originals with the
[one-command recovery downloader](MEDIA_AUDIT.md#export-unresolved-media-failures)
and use your preferred recovery tools.

For a whole-library decode audit, use the separate media-audit tool. Its
optional conversion mode validates a viewing copy before archiving the
original beside it. Read the [audit and repair guide](MEDIA_AUDIT.md) before
running it on a large source collection.

## Manage the Docker host

On a guided installation, **Settings → Host & folders** also lets you set RAM, swap and network access, restart the service, schedule a start after a stop, or prepare a move. For a scheduled start, leave the host machine and its helper running. To start an installation that has been stopped indefinitely, open Start-Here on that machine and choose **Start existing VidStream**.

**Settings → Storage & backup → Create catalog backup** downloads a consistent SQLite snapshot after you select the download link. For a full move, choose **Host & folders → Prepare to move**. After the webapp goes offline, look for **READY TO COPY** and the matching job ID in `.vidstream-host-actions.log` beside `compose.yaml`. Copy the saved Compose file and `vidstream-local` together. Your source media lives separately and must be accessible at the destination.

For a fresh machine, **Prepare a setup file for another machine → Download compose.yaml** makes a template with the selected paths and resource limits. Place it beside Start-Here on the destination, ensure the chosen media paths exist there, and choose **Start existing VidStream**. This creates a fresh installation. Use the full move procedure above to carry over an existing catalog.

## Explore Dashboard

| Area | Use it for |
| --- | --- |
| Folder storage map | Explore nested folders with rectangles sized by indexed media bytes or file count. Click through folders or use the accessible list and breadcrumbs. |
| Artist map | Compare creator groups and explore their media. |
| Benchmark | Measure this browser's connection, available server resources, and cache storage. Download JSON to compare machines. |
| Resource readings | Inspect server CPU, memory, and available I/O or GPU readings. Docker and VM limits can reduce visible resources. |
| Indexed files | Page through cataloged media. |
| Recent scans and Server logs | Review outcomes and find current operations or issue paths. |

Storage maps use the catalog. Their totals represent indexed media, so empty
folders, unindexed documents, and cache files fall outside those media totals.
The benchmark recommends starting points for previews and cache capacity.
Run it on the network and viewing device you normally use.
[Benchmark guide](BENCHMARK.md) · [Hardware](HARDWARE.md)

## Connect another machine

Set the main starting instance to **Server** under **Settings → Nodes**.
Enter the other machine's reachable address, choose **Check library**, review
its name and identity, then add it to the switcher. Use **Node** at the top
center to open that machine.

Each instance keeps its own media, catalog, sign-in, history, and cache. Your
browser connects directly to the selected machine. A Node can serve its
existing library and announce itself when optional discovery is enabled.
Change its role to Server if it should add other machines or folders.

Manual addresses work when the network blocks discovery. Each destination
needs to be reachable from your viewing device. [Nodes guide](NODES.md)

## Quick edits, backups, and library tools

**Quick edit** in the viewer provides temporary rotation, brightness, and video
volume. These reset when you change media.

The saved crop/trim workflow needs write access to the source. Preview your
edit, then choose **Save edit & keep original**. It replaces the source with
the edited version, rebuilds derivatives, and keeps the original in
`.vidstream-originals` beside the media. Guided mounts begin read-only, so
those mounts can use temporary viewing controls and edit previews. Include
hidden edit archives in your media backups.

Other maintenance actions are under **Settings → Storage & backup**.

| Tool | How to use it |
| --- | --- |
| Background work | Choose Browse comfortably, Balanced, or Process faster to set the background processing budget. |
| Refresh status / Retry or reconcile library | Inspect active and queued jobs, or ask the server to scan again. Use Media repairs to retry a single file. |
| Measure storage | See how much disk space the indexed originals, database, thumbnails, video clips, and compatible copies occupy, plus the free space on the cache disk. |
| Create catalog backup | Download a consistent SQLite snapshot. Back up source media and complete persistent state separately. |
| Relink or label media | Enter the permanent media ID from Info and a new relative path. VidStream verifies the source before attaching the existing history. |
| Artist display label | Change the catalog label without renaming the source folder. Clear it to restore the folder label. |
| Activity retention | Choose a cutoff in days and confirm to delete older individual activity events. Cumulative counts and playback positions are retained. |

**Settings → Account & history → Record media activity** controls optional
viewing-history recording. **Settings → Account & history** shows recent recorded events.

Optional local recognition can add face/pet presence, OCR text, and duplicate
suggestions. General object tags need the optional recognition stack and
weights. Review [hardware and recognition setup](HARDWARE.md) before enabling
it for a large import. Prepare upscaling or frame interpolation in your own
media tools, then mount the finished files.

For a move to a new host, use **Start-Here → Prepare storage to move**, stop
the old instance, and copy the complete saved state and configuration. Keep
the media's container-relative paths consistent. A separate new node gets its
own state. [Migration guide](PORTABLE_CACHE.md)

## Keep the app current

1. On the machine you want to update, open **Settings → Updates → Check for
   updates**. It compares the running build's commit with the official GitHub
   `main` commit. When they match, your current session carries on.
2. If there's a newer build, choose **Install update**. You can keep browsing
   during the image build. Playback may briefly pause when the server switches
   over. The saved folders, catalog, and cache stay with this installation.
3. When the update finishes, reload your gallery. To do the same update over
   SSH, choose **Update VidStream** in Start-Here on that host.

If Settings can't connect to the update helper, choose **Start existing
VidStream** in the launcher on that machine. Do this once after a host
reboot too. For an older installation without the Updates tab, start with
the one-time upgrade instructions. The browser install option is for guided
Git checkouts using the local starter image. [Update and reconnection guide](STARTER.md#update-an-existing-installation)

## Something feels off

| What you see | Try this |
| --- | --- |
| Empty gallery | Check the host's folder path and Docker mount, then use Scan library now. Check Scan activity for failures. |
| New folder missing | Apply the updated Compose file. Recreating the service loads changed mounts. |
| New media missing | Scan the selected folder, or check your scan schedule. |
| Long preview pauses at a minute change | Let the new sample finish generating. Later visits can reuse its cached clip. |
| Slow grid or stuttering | Use Optimized previews, reduce Concurrent previews, try Lightweight gallery, and benchmark from that device. |
| Original will not play | Check Media repairs and compatible-copy preparation, then inspect the source codec and permissions. |
| Server hostname refuses the connection | Check the published port, LAN binding, hostname resolution, and host firewall. A loopback listener accepts local connections. |
| Node unreachable | Open its address directly from the same browser/device. Check that machine's port and sign-in. |
| Catalog appears missing after an update | Check the Compose file, project name, and data mounts before starting a fresh import. [Storage reference](COMMANDS.md#compose-files-and-persistent-data) |
| Image pull fails | Check the configured tag and registry access. The default starter can build from its source checkout. |

[Start-Here](STARTER.md) · [Commands](COMMANDS.md) · [Media recovery](MEDIA_AUDIT.md) · [Security](../SECURITY.md)
