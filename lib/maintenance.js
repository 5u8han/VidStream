'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function bytes(dir, exclude = null) {
  if (exclude && path.resolve(dir) === path.resolve(exclude)) return 0;
  let total = 0;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await bytes(file, exclude);
      else if (entry.isFile()) total += (await fs.stat(file)).size;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return total;
}
class Maintenance {
  constructor(cfg, db) {
    Object.assign(this, { cfg, db });
  }
  async storage() {
    const data = this.cfg.dataDir,
      cache = this.cfg.cacheDir;
    const [cacheBytes, dataBytes, archiveBytes, free] = await Promise.all([
      bytes(cache, data),
      bytes(data),
      bytes(this.cfg.originalsDir || path.join(data, 'originals', 'original')),
      fs.statfs(data)
    ]);
    return {
      originalMediaBytes: [...this.db.items.values()].reduce((n, i) => n + (i.size || 0), 0),
      cacheBytes,
      dataBytes,
      archiveBytes,
      freeBytes: Number(free.bavail) * Number(free.bsize),
      paths: { media: this.cfg.mediaDir, data, cache, originals: this.cfg.originalsDir },
      note: 'Sizes count local files, exclude symlinks, and do not include unindexed source media. Data includes the catalog and any retained files from previous versions.'
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
