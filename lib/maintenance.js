'use strict';
const { filesystemCapacity } = require('./filesystem-capacity');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function measure(directory, { exclude = null, group = false } = {}) {
  const root = path.resolve(directory);
  const blocked = exclude && path.resolve(exclude);
  const total = { files: 0, bytes: 0, allocatedBytes: 0 };
  const categories = Object.create(null);
  const queue = [{ dir: root, category: null }];
  function add(target, stat) {
    target.files++;
    target.bytes += stat.size;
    target.allocatedBytes += Number.isSafeInteger(stat.blocks) ? stat.blocks * 512 : stat.size;
  }
  while (queue.length) {
    const { dir, category } = queue.pop();
    if (blocked === dir) continue;
    const handle = await fs.opendir(dir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!handle) continue;
    const pending = [];
    let statError;
    const flush = async () => {
      await Promise.all(pending.splice(0));
      if (statError) throw statError;
    };
    try {
      for await (const entry of handle) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push({ dir: file, category: category || entry.name });
        } else if (entry.isFile()) {
          pending.push(fs.lstat(file).then(stat => {
            if (!stat.isFile()) return;
            add(total, stat);
            if (!group) return;
            const key = category || '(root)';
            categories[key] ??= { files: 0, bytes: 0, allocatedBytes: 0 };
            add(categories[key], stat);
          }).catch(error => { if (error.code !== 'ENOENT') statError ??= error; }));
          if (pending.length >= 32) await flush();
        }
      }
    } finally {
      await flush();
    }
  }
  return { ...total, categories };
}

async function bytes(dir, exclude = null) {
  return (await measure(dir, { exclude })).bytes;
}
class Maintenance {
  constructor(cfg, db) {
    Object.assign(this, { cfg, db });
  }
  async storage() {
    if (!this.measurement) this.measurement = this._storage().finally(() => { this.measurement = null; });
    return this.measurement;
  }
  async _storage() {
    const data = this.cfg.dataDir;
    const cache = this.cfg.cacheDir;
    const backing = this.cfg.cacheSnapshotDir ? path.dirname(this.cfg.cacheSnapshotDir) : null;
    const archive = this.cfg.originalsDir || path.join(data, 'originals', 'original');
    const freeAt = dir => filesystemCapacity(dir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const [cacheStats, backingStats, dataStats, archiveStats, free, cacheFree] = await Promise.all([
      measure(cache, { exclude: data, group: true }),
      backing ? measure(backing, { exclude: data, group: true }) : null,
      measure(data),
      measure(archive),
      freeAt(data),
      freeAt(backing || cache)
    ]);
    const capacity = info => info ? Number(info.freeBytes) : null;
    const media = { photo: 0, video: 0, bytes: 0 };
    for (const item of this.db.visibleItems()) {
      if (item.type === 'photo' || item.type === 'video') media[item.type]++;
      media.bytes += item.size || 0;
    }
    return {
      originalMediaBytes: media.bytes,
      media,
      cacheBytes: cacheStats.bytes,
      cacheFreeBytes: capacity(cacheFree),
      cacheRetention: this.cfg.derivativeCache?.stats ?? null,
      dataBytes: dataStats.bytes,
      archiveBytes: archiveStats.bytes,
      freeBytes: capacity(free),
      measuredAt: new Date().toISOString(),
      allocation: { cache: cacheStats, cacheBacking: backingStats, data: dataStats, archive: archiveStats },
      paths: { media: this.cfg.mediaDir, data, cache, originals: archive },
      note: 'Allocated bytes include filesystem blocks when available. Project from a representative scan. Original-playback caching and compatible video copies depend on what you watch, and filesystem and database growth need spare capacity.'
    };
  }
  async backup() {
    const dir = path.join(this.cfg.dataDir, 'backups');
    await fs.mkdir(dir, { recursive: true });
    const name = 'library-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8) + '.sqlite',
      file = path.join(dir, name);
    const sqlite = require('node:sqlite');
    if (typeof sqlite.backup === 'function') await sqlite.backup(this.db.store.sql, file);
    else this.db.store.sql.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
    return {
      name,
      file,
      note: 'Consistent SQLite snapshot. Media, retained files and server configuration must be copied separately when transferring machines.'
    };
  }
  pruneActivity(days) {
    if (!Number.isInteger(days) || days < 7 || days > 3650)
      throw Error('Choose 7–3650 days of raw activity to retain');
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = this.db.store.sql
      .prepare('DELETE FROM activity WHERE occurred_at<?')
      .run(cutoff);
    this.db.store.setSetting('activityRetentionDays', days);
    return {
      removed: result.changes,
      note: 'Raw old events removed; per-media cumulative counts and last viewing positions are retained.'
    };
  }
}
module.exports = { Maintenance, bytes };
