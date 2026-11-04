# Optional RAM runtime cache

The normal configuration continues to use the persistent `stream-cache` Docker volume. RAM mode is opt-in. It changes where rebuildable previews, posters, resized photos, compatible-playback copies and optional recognition weights live while VidStream runs. It does not put original media, the SQLite catalog, accounts, preferences or viewing history into RAM.

The RAM cache is a bounded Linux `tmpfs` mount inside Docker. On a graceful stop, VidStream stops accepting requests, closes media connections, stops queued work, waits for active work, then saves a checked snapshot to `stream-cache`. At startup it restores the last committed snapshot before opening the gallery. When first enabling RAM mode, an existing ordinary cache volume is imported without moving or deleting its old files. Saved identity and history remain in `stream-data`.

This is not a browser-memory cache and will not fix a browser retaining too many tiles or video decoders. The operating system already caches frequently read disk files. RAM mode can help disk-bound preview access, but its benefit needs measurement, and a large library's complete derivative cache may not fit. There is no automatic disk spill or eviction in this mode.

## Enable it deliberately

Keep your current media/archive binds and existing volume definitions. Add `docker-compose.ram-cache.yml` **last** in the Compose file list you already use; it replaces only the `/app/.cache` mount and preserves the other mounts. In particular, keep any local override that declares your existing external volumes. Do not change the Compose project name: that would select different volume names.

For an installation using only the base Compose file:

```sh
docker compose -f docker-compose.yml -f docker-compose.ram-cache.yml up -d --build
```

This builds the current source and recreates the service with the optional RAM cache. Existing named volumes and media binds remain; this command does not delete media, configuration or Docker volumes. If you use other Compose files, retain those in this command before the RAM overlay. Docker Desktop/your VM must have enough assigned memory first.

The following `.env` settings are optional. They are configuration values, not terminal commands:

```dotenv
# Maximum runtime cache: bytes; example is 1 GiB.
STREAM_RAM_CACHE_SIZE=1073741824
# Total container memory: cache PLUS Node, encoders and recognition workers.
STREAM_MEM_LIMIT=4g
# Time Docker allows for active work and writing a snapshot before force-kill.
STREAM_CACHE_STOP_GRACE=5m
# 0 restores the previous cache; 1 deliberately rebuilds runtime cache instead.
STREAM_CACHE_COLD_START=0
```

The overlay defaults to these values. Its equal memory/swap limits prevent container swap allowance, but Docker Desktop's VM or the host itself can still swap. It is therefore an in-memory filesystem, not a guarantee that every byte always stays in physical RAM. `tmpfs` usage counts toward the container memory limit. The tmpfs limit is a ceiling, not memory reserved at startup. See [Docker tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/) and [Docker memory limits](https://docs.docker.com/engine/containers/resource_constraints/#memory).

If the saved cache cannot fit in available runtime storage, startup fails before partially restoring it, leaving the disk snapshot intact. Increase the cache/container/VM allocation together, or use a deliberate cold start. If cache generation later fills tmpfs, derivative writes can fail; existing usable media and durable catalog records remain. A cold start does not make an oversized full library fit indefinitely. Use disk mode for collections larger than the available cache budget.

## Stop, restart and test with an empty cache

```sh
docker compose -f docker-compose.yml -f docker-compose.ram-cache.yml stop
```

This signals a graceful stop and allows the configured grace period for a disk snapshot. It stops the app without deleting containers, named volumes, original media or configuration. Retain any additional Compose files your installation uses in this command too.

Use the same file list with `up -d` to start again: that starts/recreates the configured service and restores the saved cache, retaining media and persistent data. A machine losing power, an out-of-memory kill, `SIGKILL`, or Docker exhausting its stop timeout cannot run shutdown code. Newly generated RAM cache can be lost in those cases; the previous committed snapshot is retained. The cache is rebuildable, and originals/history are not dependent on that shutdown copy.

To test without loading an old cache, set `STREAM_CACHE_COLD_START=1` and recreate with the enable command above. Startup then clears only the volatile runtime cache and skips both snapshots and legacy cache files. It retains the saved snapshot until the next successful graceful stop replaces it with the new cache. Set the value back to `0` afterward, or every restart will deliberately rebuild again. This is the preferred cache-only reset: it does not reset accounts/history or delete media.

## Docker volume deletion has broader effects

Docker's `down --volumes` removes this project's non-external named volumes, including `stream-cache`, so it also removes saved RAM snapshots. The usual full reset spelling is `docker compose down --rmi all --volumes` (not `-rmi -all -v`). That destructive reset also removes application images and **other non-external project volumes**, including `stream-data` with accounts/history and the default `stream-originals` archive volume. It is not a cache-only reset. Existing external volumes and host bind-mounted media are not deleted by Compose `down`; host configuration files remain too. See [Docker Compose down](https://docs.docker.com/reference/cli/docker/compose/down/).

For existing deployments with an **external** `stream-cache` volume, Compose deliberately preserves that volume even with `--volumes`. Use the cold-start setting for cache testing. Manual volume removal must identify the actual cache volume and must never target the data or originals volume. VidStream does not intercept or override Docker's volume deletion rules.

## Snapshot integrity and native runs

Each snapshot is copied into a fresh generation with file hashes. Only after files and its manifest are flushed is an atomic pointer switched to that generation. An interrupted or failed copy never replaces the previous committed snapshot. Temporary encoder outputs and staging files are excluded. Restored files are verified; a corrupt snapshot fails clearly rather than serving damaged previews. A failed shutdown copy logs an error and exits unsuccessfully while retaining the last good snapshot. The disk volume needs enough free space for the existing snapshot plus a new one during saving; first-run legacy files are retained too.

Only precisely named, obsolete or uncommitted snapshot generations are cleaned automatically; the current committed generation, unrelated files and legacy files are retained. Each running instance needs its own cache volume. Shutdown stops traversal between directories/files, but cannot cancel an operating-system directory read or an active disk read that is blocked on unavailable storage; that can still exhaust Docker's grace period.

For native runs, `CACHE_SNAPSHOT_DIR` enables the same lifecycle, `CACHE_COLD_START=1` skips restore, and `CACHE_DIR` must already point to a RAM disk created by the operating system. These variables do not create a native RAM disk. Explicitly retain a separate persistent `DATA_DIR`; the application rejects overlap between runtime cache, snapshot, media, database and originals directories. Returning from RAM mode to ordinary disk mode can rebuild missing recent cache files; the durable catalog/history remain unchanged.
