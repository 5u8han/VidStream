# Select media folders in Docker Compose

Give each selected host folder a separate read-only mount directly under
`/media/collections` in the same VidStream service. For example, mount your
`CiVit` directory at `/media/collections/CiVit` and your `Animations` directory
at `/media/collections/Animations`. VidStream reads the immediate directories
under that container path on startup. It lists their names in the top-left menu
and scans their contents recursively. The container directory name supplies the
menu label and the first segment of the catalog path. Loose files directly
under `/media/collections`, dot-prefixed folders and symlink entries are skipped.

Copy the example from the VidStream checkout.

```sh
cp -n docker-compose.media.example.yml docker-compose.media.local.yml
```

This creates a private local Compose file and preserves an existing copy. Git
and the Docker build context ignore the local file.

Edit `docker-compose.media.local.yml` and replace the example binds with the
folders you want. Set `source` to the real absolute host path and `target` to a
unique direct child of `/media/collections`. The provided bind settings make
media read-only and require the source to exist. Use one bind per selected
folder, with distinct targets. A Docker host must have access to each path,
including any NAS mounts, before starting the service.

Put the folder you want to see first in the template's first mount. Leave
`&primary_media` on that `target` line. `MEDIA_PRIMARY_MOUNT: *primary_media`
uses the same target automatically. The marker records the primary folder in
Compose because the container's directory listing has its own order. If you
reorder the entries, move the marker to the new first target. The primary
folder opens on sign-in and when the gallery reloads. If that mount is removed
or hidden from a guest, the gallery opens the first folder that viewer can see.

Remove the old whole-library media bind from your local Compose configuration
when switching to child mounts. Retain your existing Compose project name,
data/cache volumes, archive mount and other settings. The new media override
uses a separate container path from the older `/media/original` setup. Keep
`/media/collections` reserved for the individual media mounts.

With just the base file and the media override, apply the configuration from
your VidStream checkout.

```sh
docker compose -f docker-compose.yml -f docker-compose.media.local.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.media.local.yml up -d --build stream
```

- `config --quiet` validates the merged configuration as a read-only check.
- `up -d --build stream` builds the current app and recreates the service with
  the selected read-only media binds. It reuses your configured persistent
  volumes and briefly interrupts playback during recreation.

If you already use additional Compose files, retain them in the same order
and append the media file last in both commands. If your `.env` specifies
`COMPOSE_FILE`, you can append the media file to that list and keep your usual
Compose workflow instead. Changing Docker binds requires recreating the
container through Compose. After building this version once, omit `--build`
when applying mount changes to reuse the current image. An ordinary container
restart uses the existing mounts.

The new mode uses one server, account and database. **All media** includes the
active folders. Removing a bind and recreating the container takes that folder
out of the gallery and scanner. Its catalog entries, history and cached previews
stay in persistent storage. If you return the same folder to the same target
name, VidStream can reuse those records. When switching from a parent-folder
bind, match the original top-level names exactly to preserve the relative paths.
Use a new target name for an unrelated source directory.

The initial import still processes all media under each selected folder. Add
large folders in stages if you want to spread out initial scanning and preview
generation. Existing owner and guest visibility rules apply within the active
folders.
