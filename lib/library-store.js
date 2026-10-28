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
    if (version > 1) throw Error('Library database is newer than this version of Stream. Upgrade Stream; do not reset the database.');
    this.sql.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS media_state (path TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_path ON events(path, id);
      PRAGMA user_version=1;
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
  close() { this.sql.close(); }
}
module.exports = { LibraryStore };
