# One server, manually chosen folders

The folder menu keeps one VidStream server, address, sign-in and catalog. It
changes which part of that catalog the gallery shows. Your existing nested
directories stay where they are. No extra containers or Kubernetes are needed.

## Configure the menu

1. Mount the existing parent media directory as described in the main README.
2. Sign in as the owner. Open the title in the top-left corner, then **Choose
   folders…**, or open **Settings → Folders**.
3. Select **Add folder**. Enter a short menu name and the folder's path relative
   to the mounted media directory. Save the folder menu.

For example, if the mounted root contains `Private/By year/2025/Artist/clip.mp4`,
a shortcut named **Private** with path `Private` includes that video and all
other supported media below `Private`. A shortcut named **2025** with path
`Private/By year/2025` includes only that subtree. A blank path means the whole
mounted root. Use `/` between path segments on all platforms; do not enter a
host's absolute directory address, a container path or `..`.

The shortcut names, paths and order are saved in this server's persistent
database. Up to 64 shortcuts are supported. The selected shortcut is remembered
on each browser separately and survives an ordinary browser restart. **All
media** returns to the whole accessible catalog. Removing a shortcut changes
navigation only; it does not delete media, previews or history.

Once shortcuts are configured, the old automatically enumerated album and
artist dropdowns are hidden. Search, media-type filters and sorting continue
inside the chosen folder. Player Previous/Next follows that same selection.
Removing every shortcut restores the legacy selectors. A missing or removed
saved selection falls back to All media on a new page load; an invalid folder
ID in an API request returns an error rather than silently returning everything.

The existing scan still indexes the mounted root recursively. Switching
shortcuts queries the existing catalog; it does not trigger a scan or copy
files. This menu supports the application's existing photo/video formats; it
does not add document rendering for PDF or every file extension in a folder.

## Sharing and privacy

Shortcuts are navigation, not new access-control boundaries. Owner sign-in can
still access the whole catalog. Existing whole-server sign-in and per-media
guest visibility continue to apply. Guests receive only shortcut names with
guest-visible media below them; the menu API omits their configured paths and
collections containing no guest-visible items. A selected folder does not make
other shared items private. Library statistics and owner tools remain scoped
to the server as a whole.

## Large libraries

The gallery keeps lightweight tile shells for scroll geometry and hydrates
images, video sources and controls near the viewport. Distant tile contents
are released and recreated on return, including when unlimited visible
previews are selected. This reduces accumulated decoding and element costs;
the catalog and tile shells are not an unlimited-size virtual list.

Folder filtering and a server RAM cache solve different problems. Filtering
narrows the gallery; viewport management reduces browser retention. The
optional [RAM cache](RAM_CACHE.md) changes where server-generated previews are
stored and cannot by itself fix browser scrolling or create extra display
frames. Original files, source frame rates and playback compatibility remain
unchanged.
