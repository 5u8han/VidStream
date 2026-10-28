'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Durable user choices are separate from the rebuildable derivative/index cache.
// Never reset this database on scan, missing media, or application upgrades.
class LibraryStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.sql = new DatabaseSync(path.join(dir, 'library.sqlite'));
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.sql.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw Error('Library database is newer than this version of Stream. Upgrade Stream; do not reset the database.');
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
        watch_seconds REAL NOT NULL DEFAULT 0, last_opened TEXT);
      CREATE TABLE IF NOT EXISTS enhancement_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=2;
      COMMIT;`);
    this.read = this.sql.prepare('SELECT data FROM media_state WHERE path=?');
    this.write = this.sql.prepare('INSERT INTO media_state(path,data) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data');
    this.event = this.sql.prepare('INSERT INTO events(path,at,action,data) VALUES(?,?,?,?)');
  }
  key(item) { return item.relPath || item.id; }
  hydrate(item) {
    const key = this.key(item);
    const saved = this.read.get(key);
    if (saved) Object.assign(item, JSON.parse(saved.data));
    else {
      const initial = { favorite: !!item.favorite, pinned: !!item.pinned, bookmarked: !!item.bookmarked,
        guest: item.guest === true, addedAt: item.addedAt || new Date().toISOString() };
      this.write.run(key, JSON.stringify(initial));
      Object.assign(item, initial);
    }
    item.history = this.history(item);
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
      this.sql.exec('COMMIT');
    } catch (err) { this.sql.exec('ROLLBACK'); throw err; }
    Object.assign(item, data);
    item.history = this.history(item);
    return item;
  }
  record(item, action, data) {
    this.event.run(this.key(item), new Date().toISOString(), action, JSON.stringify(data));
    item.history = this.history(item);
  }
  history(item) {
    return this.sql.prepare('SELECT id,at,action,data FROM events WHERE path=? ORDER BY id DESC LIMIT 100')
      .all(this.key(item)).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  setting(key, fallback = null) {
    const row = this.sql.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.sql.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  track(item, event) {
    const key = this.key(item), received = new Date().toISOString();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = this.sql.prepare('INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?,?,?)')
        .run(event.id, key, item.id, event.visitor, event.action, event.at, received, JSON.stringify(event.details));
      if (result.changes) {
        this.sql.prepare(`INSERT INTO activity_totals(path,opens,hovers,plays,watch_seconds,last_opened) VALUES(?,?,?,?,?,?)
          ON CONFLICT(path) DO UPDATE SET opens=opens+excluded.opens, hovers=hovers+excluded.hovers,
          plays=plays+excluded.plays, watch_seconds=watch_seconds+excluded.watch_seconds,
          last_opened=CASE WHEN excluded.last_opened IS NULL THEN last_opened ELSE MAX(COALESCE(last_opened,''),excluded.last_opened) END`)
          .run(key, Number(event.action === 'open'), Number(event.action === 'hover'), Number(event.action === 'play'),
            event.action === 'watch' ? event.details.seconds : 0, event.action === 'open' ? event.at : null);
      }
      this.sql.exec('COMMIT');
      return Boolean(result.changes);
    } catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  activityStats(item) {
    return this.sql.prepare('SELECT opens,hovers,plays,watch_seconds,last_opened FROM activity_totals WHERE path=?').get(this.key(item)) ||
      {opens:0,hovers:0,plays:0,watch_seconds:0,last_opened:null};
  }
  activityPage(before = null, limit = 100, mediaPath = null) {
    const rows = this.sql.prepare(`SELECT rowid AS cursor,* FROM activity WHERE (? IS NULL OR rowid<?)
      AND (? IS NULL OR path=?) ORDER BY rowid DESC LIMIT ?`).all(before,before,mediaPath,mediaPath,limit);
    return { events:rows.map(row=>({...row,details:JSON.parse(row.details)})), next:rows.length===limit ? rows[rows.length-1].cursor : null };
  }
  saveJob(job) { this.sql.prepare('INSERT INTO enhancement_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job)); }
  jobs() { return this.sql.prepare('SELECT data FROM enhancement_jobs ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data)); }
  close() { this.sql.close(); }
}
module.exports = { LibraryStore };
