'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('./catalog');

// Durable user choices are separate from the rebuildable derivative/index cache.
// Never reset this database on scan, missing media, or application upgrades.
class LibraryStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'library.sqlite');
    const existed = fs.existsSync(this.file) && fs.statSync(this.file).size > 0;
    this.sql = new DatabaseSync(this.file);
    const version = this.sql.prepare('PRAGMA user_version').get().user_version;
    if (version > 3) {
      this.sql.close();
      throw Error(
        'Library database is newer than this version of Stream. Upgrade Stream; do not reset the database.'
      );
    }
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (existed && version < 3) {
      const backups = path.join(dir, 'migration-backups');
      fs.mkdirSync(backups, { recursive: true });
      this.migrationBackup = path.join(
        backups,
        'library-v' + version + '-' + Date.now() + '-' + catalog.identity() + '.sqlite'
      );
      this.sql.prepare('VACUUM INTO ?').run(this.migrationBackup);
    }
    this.sql.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS media_state (path TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_path ON events(path, id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (
        event_key TEXT PRIMARY KEY, path TEXT NOT NULL, item_id TEXT NOT NULL,
        visitor TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_path_time ON activity(path, received_at);
      CREATE INDEX IF NOT EXISTS activity_time ON activity(received_at);
      CREATE TABLE IF NOT EXISTS activity_totals (
        path TEXT PRIMARY KEY, opens INTEGER NOT NULL DEFAULT 0,
        hovers INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
        watch_seconds REAL NOT NULL DEFAULT 0, last_opened TEXT, last_position REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS enhancement_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS enhancement_job_state ON enhancement_jobs(json_extract(data,'$.state'));
      CREATE INDEX IF NOT EXISTS enhancement_job_item ON enhancement_jobs(json_extract(data,'$.itemId'),json_extract(data,'$.sourceFingerprint'));
      `);
    if (
      !this.sql
        .prepare('PRAGMA table_info(activity_totals)')
        .all()
        .some((column) => column.name === 'last_position')
    )
      this.sql.exec('ALTER TABLE activity_totals ADD COLUMN last_position REAL NOT NULL DEFAULT 0');
    catalog.schema(this.sql);
    this.sql.exec('PRAGMA user_version=3; COMMIT;');
    this.read = this.sql.prepare('SELECT data FROM media_state WHERE path=?');
    this.write = this.sql.prepare(
      'INSERT INTO media_state(path,data) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data'
    );
    this.event = this.sql.prepare('INSERT INTO events(path,at,action,data) VALUES(?,?,?,?)');
  }
  key(item) {
    return item.relPath || item.id;
  }
  hydrate(item) {
    const key = this.key(item);
    const saved = this.read.get(key);
    if (saved) {
      const data = JSON.parse(saved.data);
      Object.assign(item, data);
      if (!item.mediaId) {
        item.mediaId = catalog.identity();
        this.write.run(key, JSON.stringify({ ...data, mediaId: item.mediaId }));
      }
    } else {
      const initial = {
        favorite: !!item.favorite,
        pinned: !!item.pinned,
        bookmarked: !!item.bookmarked,
        guest: item.guest === true,
        addedAt: item.addedAt || new Date().toISOString(),
        mediaId: item.mediaId || catalog.identity()
      };
      this.write.run(key, JSON.stringify(initial));
      Object.assign(item, initial);
    }
    item.history = this.history(item);
    item.variants = this.variants(item);
    item.activity = this.activityStats(item);
    return item;
  }
  update(item, changes, action = 'preferences') {
    const key = this.key(item);
    const existing = this.read.get(key);
    const data = { ...(existing ? JSON.parse(existing.data) : {}), ...changes };
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.write.run(key, JSON.stringify(data));
      this.event.run(key, new Date().toISOString(), action, JSON.stringify(changes));
      if (
        item.mediaId &&
        this.sql.prepare('SELECT 1 FROM catalog WHERE media_id=?').get(item.mediaId)
      )
        this.saveCatalog({ ...item, ...data });
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
    Object.assign(item, data);
    item.history = this.history(item);
    return item;
  }
  record(item, action, data) {
    this.event.run(this.key(item), new Date().toISOString(), action, JSON.stringify(data));
    item.history = this.history(item);
  }
  history(item) {
    return this.sql
      .prepare('SELECT id,at,action,data FROM events WHERE path=? ORDER BY id DESC LIMIT 100')
      .all(this.key(item))
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  setting(key, fallback = null) {
    const row = this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.sql
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, JSON.stringify(value));
  }
  track(item, event) {
    const key = this.key(item),
      received = new Date().toISOString();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = this.sql
        .prepare('INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?,?,?)')
        .run(
          event.id,
          key,
          item.id,
          event.visitor,
          event.action,
          event.at,
          received,
          JSON.stringify(event.details)
        );
      if (result.changes) {
        this.sql
          .prepare(
            `INSERT INTO activity_totals(path,opens,hovers,plays,watch_seconds,last_opened,last_position) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(path) DO UPDATE SET opens=opens+excluded.opens, hovers=hovers+excluded.hovers,
          plays=plays+excluded.plays, watch_seconds=watch_seconds+excluded.watch_seconds,
          last_opened=CASE WHEN excluded.last_opened IS NULL THEN last_opened ELSE MAX(COALESCE(last_opened,''),excluded.last_opened) END,
          last_position=CASE WHEN ? THEN excluded.last_position ELSE last_position END`
          )
          .run(
            key,
            Number(event.action === 'open'),
            Number(event.action === 'hover'),
            Number(event.action === 'play'),
            event.action === 'watch' ? event.details.seconds : 0,
            event.action === 'open' ? event.at : null,
            event.details.position || 0,
            Number(['watch', 'seek', 'pause', 'ended'].includes(event.action))
          );
      }
      this.sql.exec('COMMIT');
      item.activity = this.activityStats(item);
      return Boolean(result.changes);
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  activityStats(item) {
    const row = this.sql
      .prepare(
        'SELECT opens,hovers,plays,watch_seconds,last_opened,last_position FROM activity_totals WHERE path=?'
      )
      .get(this.key(item)) || {
      opens: 0,
      hovers: 0,
      plays: 0,
      watch_seconds: 0,
      last_opened: null,
      last_position: 0
    };
    return { ...row, position: row.last_position };
  }
  activityPage(before = null, limit = 100, mediaPath = null) {
    const rows = this.sql
      .prepare(
        `SELECT rowid AS cursor,* FROM activity WHERE (? IS NULL OR rowid<?)
      AND (? IS NULL OR path=?) ORDER BY rowid DESC LIMIT ?`
      )
      .all(before, before, mediaPath, mediaPath, limit);
    return {
      events: rows.map((row) => ({ ...row, details: JSON.parse(row.details) })),
      next: rows.length === limit ? rows[rows.length - 1].cursor : null
    };
  }
  saveJob(job) {
    if (job.itemId && !job.sourceVersion) {
      const item = this.sql
        .prepare('SELECT data FROM catalog WHERE id=? OR media_id=? LIMIT 1')
        .get(job.itemId, job.itemId);
      if (item) {
        const current = JSON.parse(item.data);
        if (job.sourceFingerprint === current.fingerprint) {
          job.sourceVersion = current.sourceVersion || catalog.sourceVersion(current);
          job.mediaId = current.mediaId;
        }
      }
    }
    this.sql
      .prepare(
        'INSERT INTO enhancement_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(job.id, JSON.stringify(job));
  }
  job(id) {
    const row = this.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  nextJob() {
    const row = this.sql
      .prepare(
        "SELECT data FROM enhancement_jobs WHERE json_extract(data,'$.state') IN ('queued','running') ORDER BY rowid LIMIT 1"
      )
      .get();
    return row ? JSON.parse(row.data) : null;
  }
  matchingJob(item, options) {
    const rows = this.sql
      .prepare(
        "SELECT data FROM enhancement_jobs WHERE (json_extract(data,'$.itemId')=? OR json_extract(data,'$.mediaId')=?) AND json_extract(data,'$.state')!='cancelled' ORDER BY rowid DESC"
      )
      .all(item.id, item.mediaId || '');
    return (
      rows
        .map((row) => JSON.parse(row.data))
        .find(
          (job) =>
            JSON.stringify(job.options) === JSON.stringify(options) && this.jobMatches(item, job)
        ) || null
    );
  }
  jobMatches(item, job) {
    return job.sourceVersion && catalog.sourceVersion(item)
      ? job.sourceVersion === catalog.sourceVersion(item)
      : catalog.sourceVersion({ fingerprint: job.sourceFingerprint }) ===
          catalog.sourceVersion(item);
  }
  jobPage(item = null, offset = 0, limit = 50) {
    const where = item ? " WHERE json_extract(data,'$.itemId')=?" : '',
      params = item ? [item] : [];
    const total = this.sql
      .prepare('SELECT COUNT(*) AS count FROM enhancement_jobs' + where)
      .get(...params).count;
    const jobs = this.sql
      .prepare(
        'SELECT data FROM enhancement_jobs' + where + ' ORDER BY rowid DESC LIMIT ? OFFSET ?'
      )
      .all(...params, limit, offset)
      .map((r) => JSON.parse(r.data));
    return {
      jobs,
      total,
      offset,
      nextOffset: offset + jobs.length < total ? offset + jobs.length : null
    };
  }
  jobs() {
    return this.sql
      .prepare('SELECT data FROM enhancement_jobs ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.data));
  }
  saveCatalog(item) {
    catalog.save(this.sql, item);
  }
  catalogItems() {
    return this.sql
      .prepare('SELECT data FROM catalog')
      .all()
      .map((row) => JSON.parse(row.data));
  }
  saveVariant(item, variant) {
    if (!item.mediaId) this.hydrate(item);
    if (!variant || typeof variant.id !== 'string' || !variant.id)
      throw Error('Variant needs an identifier');
    this.sql
      .prepare('INSERT OR REPLACE INTO media_variants VALUES(?,?,?)')
      .run(item.mediaId, variant.id, JSON.stringify(variant));
    item.variants = this.variants(item);
    return variant;
  }
  variants(item) {
    return item.mediaId
      ? this.sql
          .prepare('SELECT data FROM media_variants WHERE media_id=? ORDER BY rowid')
          .all(item.mediaId)
          .map((row) => JSON.parse(row.data))
      : [];
  }
  removeVariant(item, id) {
    this.sql.prepare('DELETE FROM media_variants WHERE media_id=? AND id=?').run(item.mediaId, id);
    item.variants = this.variants(item);
  }
  catalogPage(options) {
    const select = catalog.selection(options),
      cte = 'WITH selected AS (' + select.sql + ') ';
    const count = this.sql
      .prepare(cte + 'SELECT COUNT(*) AS count FROM selected')
      .get(...select.values).count;
    const cursor = options.cursor
      ? this.sql
          .prepare(cte + 'SELECT position FROM selected WHERE id=?')
          .get(...select.values, options.cursor)?.position || 0
      : 0;
    const rows = this.sql
      .prepare(cte + 'SELECT id FROM selected WHERE position>? ORDER BY position LIMIT ?')
      .all(...select.values, cursor, options.limit + 1);
    const more = rows.length > options.limit;
    const ids = rows.slice(0, options.limit).map((row) => row.id);
    return { ids, total: count, nextCursor: more ? ids[ids.length - 1] : null };
  }
  catalogNeighbors(id, options) {
    const select = catalog.selection(options),
      cte = 'WITH selected AS (' + select.sql + ') ';
    const row = this.sql
      .prepare(
        cte + 'SELECT position,(SELECT COUNT(*) FROM selected) AS total FROM selected WHERE id=?'
      )
      .get(...select.values, id);
    if (!row)
      return {
        index: -1,
        total: this.sql
          .prepare(cte + 'SELECT COUNT(*) AS count FROM selected')
          .get(...select.values).count,
        prev: null,
        next: null
      };
    const adjacent = this.sql
      .prepare(cte + 'SELECT id,position FROM selected WHERE position IN (?,?)')
      .all(...select.values, row.position - 1, row.position + 1);
    return {
      index: row.position - 1,
      total: row.total,
      prev: adjacent.find((v) => v.position === row.position - 1)?.id || null,
      next: adjacent.find((v) => v.position === row.position + 1)?.id || null
    };
  }
  close() {
    this.sql.close();
  }
}
module.exports = { LibraryStore };
