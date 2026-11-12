# Using VidStream

VidStream serves the photos and videos you choose from a machine you control. Use the [Start-Here guide](STARTER.md) for a guided install or [requirements and commands](COMMANDS.md) for manual Docker and native setups.

## First sign-in

1. Open the server address. A fresh Start-Here install normally uses `http://127.0.0.1:8080` on the server machine. A manually configured Docker install defaults to HTTP port 80.
2. Enter the one-time owner setup code from Start-Here or the server log. Choose a username and passphrase between 10 and 256 characters. Keep the code and logs private.
3. Sign in and check the first library. The server imports media in the background. Recently added items appear as scanning and preview generation finish.

An existing owner account stays with its persistent data. An installation that uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` or an LDAP configuration continues to use its configured sign-in. [Security and privacy](../SECURITY.md)

## Choose and browse a library

| To do this | Where to go |
| --- | --- |
| Switch folders on one server | Open the top-left library title and pick a folder or **All media**. Start-Here adds a menu entry for each mounted folder. Its first selection opens by default. |
| Add another directory on the host | Reopen Start-Here and choose **Add a media folder**. The printed Compose command applies the new read-only mount and briefly restarts the service. [Start-Here guide](STARTER.md#add-a-folder-to-an-existing-setup) |
| Manage mounts by hand | Bind each chosen host folder as a direct child of `/media/collections` and set the primary mount. [Mounted folders](MOUNTED_FOLDERS.md) |
| Create navigation shortcuts within a single media root | As owner, open **Settings → Folders** or **Choose folders…** in the title menu. Name a shortcut and give it a path relative to the mounted root. [Folder shortcuts](FOLDERS.md) |
| Switch to a separate server | Open **Settings → Nodes** as owner, check the other server's address and add it. Use **Switch library** in the top bar to open it. [Independent libraries](NODES.md) |

Mounted folders and shortcuts are both views into a server's library. A shortcut filters existing catalog records. A mount controls which files Docker makes available to index. The selected folder does not grant or revoke access. With several servers, each one stores its own catalog, accounts, history and previews. Your browser connects directly to the selected server.

The scanner recognizes JPEG, PNG, GIF, WebP, HEIC/HEIF, TIFF and BMP photos and MP4/M4V, MOV, WebM, MKV and AVI videos. Available decoders and the codecs inside a file affect whether its preview or original can play. The dashboard reports unsupported and unreadable files.

## Search, organize and change the gallery

- Use the search field for filenames, folder names, artist display labels, extracted text and object tags. Use the type filter for photos or videos. With a single root and no folder shortcuts, album and artist selectors appear when there are values to choose from.
- In **View → Show**, select **Favorites**, **Pinned**, **Bookmarks**, **Faces**, **Pets** or **Text**. As owner, use **Mark as best** on a tile or the **Best**, **Pin** and **Bookmark** controls in the viewer to set those flags.
- Use **View → Sort** for the quick choices or **View → More controls → Sort order** for oldest, name order and other options. **Artist** switches to all media sorted by artist and clears other gallery filters. **Recently opened**, **Continue watching** and **Less-seen shuffle** use recorded owner activity. In **Continue watching**, a video seeks to its saved position when opened.
- In **View → More controls → Dates and resolution**, filter on media creation or import dates, a date range and minimum resolution. In **Saved views**, name and save the current filter and sort choices for reuse in this browser. **Pin to toolbar** adds quick buttons for shuffle, favorites or pausing previews.
- Use the **Media size** slider and choose **Whole frame** or **Fill tiles**. Use a video's resize control to enlarge one tile. **Randomly enlarge videos** and **Reshuffle** adjust the arrangement. **Artist outlines** offers fine borders, outlines on hover and an optional color shuffle.
- **Settings → Appearance** controls theme and visual effects. The browser's reduced-motion preference applies. Effects and several playback choices are browser-specific, so set them separately on a phone, tablet or desktop.

## Play, inspect and share

Select any tile to open the viewer. Use **Previous** or **Next**, or the left and right arrow keys when focus is outside native video controls. Press **Escape** to close the viewer. **Play slideshow** advances photos and continues when a video ends. Double-click to zoom or use pinch on a touch screen, then drag to pan.

Videos open the original source in the browser's player, with controls for seeking, audio and playback speed. If the browser rejects the source, VidStream can prepare a compatible copy in its cache. Wait for preparation or check the owner work queue for a failure. **Download original**, when enabled and permitted, retrieves the source. To download several allowed items together, use the gallery's **Select** control, choose the items and select **Download** to get a ZIP.

Open **Info** for available metadata, technical details and the permanent media ID. Owners can inspect stored activity and revision details. For video, use **Stats for nerds** or enable it in **Settings → Video player** to see source and viewport resolution, reported frame rates, dropped frames, buffering and the playback source. Use the same settings card to adjust background blur.

**Share** copies or opens a media link when enabled. The recipient needs a working address and permission to view that item. To share specific items with signed-out viewers, the owner can change the eye control on a tile or in the viewer. **Select** also offers bulk visibility changes. If **Require sign-in for the entire library** is on, visitors still need to sign in. Test the link in a separate signed-out browser before sending it. [Security and privacy](../SECURITY.md)

If `SHOW_RSS_FEED` is enabled, add `/feed.xml` to the server address to get recent items in an RSS reader. Signed-out readers can see only guest-visible items when the server allows guest browsing. Set `ALLOW_IMAGE_SHARING`, `ALLOW_ORIGINAL_DOWNLOAD` and `ALLOW_INDEXING` in the [configuration](../.env.example) to control the corresponding feature. Sign-in and guest visibility govern who can access media.

## Adjust previews and playback load

The optimized gallery preview is a muted, short loop at the source frame rate up to 60 fps. Actual playback depends on the browser, codec, device, storage and connection. The gallery releases media elements for distant tiles as you scroll. A large library still needs processing time and disk space for the catalog and derivatives.

- Pause or enable **Autoplay previews** in **View**. Under **More controls → Playback**, reduce the simultaneous preview limit, choose **Optimized** or **Original**, or enable **Data saver**. Data saver reloads the page to apply lighter loading behavior.
- Use **Check playback smoothness** under **Playback** to measure the current browser. In the viewer, use **Stats for nerds** to inspect an individual clip.
- If initial import competes with browsing, set **Settings → Library tools → Background work** to **Browse comfortably** and check queued and failed tasks. The dashboard reports resources visible to the process or container. [Hardware and container limits](HARDWARE.md)
- The optional [RAM cache](RAM_CACHE.md) changes where generated derivatives are kept while the server runs. Allocate memory for both the cache and the application, and allow a graceful stop to save its snapshot.

## Use Quick edit

Open **Quick edit** in the viewer for temporary rotation, brightness and video volume. These controls reset when you change media.

The owner can also enter crop position and dimensions, set a maximum width, and choose start and end times for a video. Use **Preview crop / trim**, then **Save edit & keep original** when ready. Saving replaces the source file with the edited version, rebuilds derivatives and saves the original under a hidden `.vidstream-originals` directory beside the media. It requires write access to that source, so an ordinary read-only Docker mount can only use the viewing controls and preview. Back up the hidden originals directory with the collection.

## Maintain a library as owner

| Feature | How to use it |
| --- | --- |
| Import and troubleshoot files | Open **Dashboard** from the library summary. Review counts, scan history, unsupported files, inaccessible folders and indexed items. In **Settings → Library tools**, use **Retry / reconcile library** after fixing a path or permission. **View → More controls → Refresh metadata & previews** forces a more expensive refresh. |
| Explore the library map | In **Dashboard**, choose area by storage size or file count, and show artists/folders or individual files. Select a region or item to open it. |
| Check server resources | Open **Dashboard** and review the resource readings. A container's memory limit can be lower than its host's physical RAM. [Resource guide](HARDWARE.md) |
| Use local recognition | The scanning configuration controls face/pet presence, OCR and perceptual duplicate grouping separately. Inspect or adjust the relevant `ENABLE_…` fields in [the sample configuration](../.env.example). General object tags require the optional object-recognition stack. In **Dashboard**, choose a preset model and device, download trusted weights if needed, save the enabled setting and rescan. [Hardware and recognition setup](HARDWARE.md) |
| Manage viewing history | Toggle **Record media activity** under **Settings → Library**. **Settings → History** lists recent recorded activity. To delete older raw events, use **Settings → Library tools → Activity retention**, enter a retention period and confirm. Cumulative counts and viewing positions are retained. |
| Back up the catalog | Choose **Settings → Library tools → Create catalog backup** and download the consistent SQLite snapshot. Back up the original media, hidden edit archives, private configuration and complete persistent data separately for recovery. |
| Relink a moved file | Copy its permanent media ID from **Info**. In **Settings → Library tools → Relink or label media**, enter that ID and its new path relative to the media root. VidStream checks the file's bytes and that the path belongs to no other item before linking it to the existing history. |
| Change an artist label | In the same panel, enter the media ID and save an **Artist display label**. Clear that value to restore the folder label. This changes the catalog label without renaming the source. |
| Move to another machine | Stop the old server before copying its complete data, source mapping and original archives. Keep the live SQLite data on local storage and run a single copy of that identity. Set up separate state for a new independent library. [Nodes and migration](NODES.md) |

Create any upscaled or interpolated versions in your media tools first, then add those files to a mounted folder. VidStream's preview and compatibility work supports viewing.

## Common problems

| Symptom | Check |
| --- | --- |
| The gallery is empty | Confirm that the source exists on the Docker host, the engine can read it and the mount targets the configured media root. Start-Here mounts selected subfolders under `/media/collections`. The manual single-root example uses `/media/original`. Check the dashboard for failures and allow the first scan to finish. |
| A newly added folder is absent | Recreate the container with the edited Compose file. An ordinary restart uses the prior mount configuration. In mounted mode, use a distinct direct child path and select a folder the Docker host can see. |
| The browser cannot reach another node | Open that node's LAN address directly from the device you are using. Check the published port and firewall. A loopback address works only on the server itself. Manual addresses work without multicast discovery. |
| The image cannot be pulled | Check the exact registry tag and access. Start-Here's default image can fall back to a source build from the checkout. If you explicitly configured an image, correct its tag or access and retry. [Docker Hub guide](DOCKER_HUB.md) |
| You see a port conflict | Change the starter's `VIDSTREAM_PORT` before its first run, or change the published port and `URL` in its existing `compose.yaml`. For manual Docker, set `STREAM_HTTP_PORT` and update `URL` in `.env`. |
| Your data looks missing after an update | Check the Compose file, project name and data volume. If you previously ran under a different checkout name, specify the original project with `-p`. Restore the correct mappings before starting again. [Commands and storage](COMMANDS.md#compose-files-and-persistent-data) |
| A video will not play or previews are sluggish | Try the optimized preview, fewer simultaneous previews or Data saver. For a single video, check compatible-copy preparation, the dashboard's failed items and the source file's codec and permissions. |

[Requirements and command reference](COMMANDS.md) · [Start-Here](STARTER.md) · [Security](../SECURITY.md)
