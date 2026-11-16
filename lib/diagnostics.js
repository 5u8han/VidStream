'use strict';
const { filesystemCapacity } = require('./filesystem-capacity');

const { createHash } = require('node:crypto');
const { posix } = require('node:path');

const WARN_AFTER = 60_000;
const FLUSH_AFTER = 500;

function mediaPath(value) {
  if (typeof value !== 'string' || !value || posix.isAbsolute(value) ||
      value.includes('\\') || value.split('/').some(part => part === '..')) return null;
  return value;
}

class Diagnostics {
  constructor(store, { warnAfter = WARN_AFTER, now = Date.now } = {}) {
    this.sql = store.sql;
    this.warnAfter = warnAfter;
    this.now = now;
    this.pending = new Map();
    this.watched = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_issues (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, level TEXT NOT NULL, path TEXT, stage TEXT,
        message TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        occurrences INTEGER NOT NULL, read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS diagnostic_recent ON diagnostic_issues(last_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS diagnostic_unread ON diagnostic_issues(id) WHERE read_at IS NULL;
    `);
    this.save = this.sql.prepare(`
      INSERT INTO diagnostic_issues (id,code,level,path,stage,message,first_at,last_at,occurrences)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET level=excluded.level,message=excluded.message,last_at=excluded.last_at,
        occurrences=diagnostic_issues.occurrences+excluded.occurrences,
        read_at=CASE WHEN diagnostic_issues.level<>excluded.level OR diagnostic_issues.message<>excluded.message
          OR excluded.last_at-diagnostic_issues.last_at>86400000 THEN NULL ELSE diagnostic_issues.read_at END
    `);
  }

  record({ level = 'warning', code, path, stage, message }) {
    if (this.stopped) return null;
    const source = mediaPath(path);
    const phase = stage ? String(stage).slice(0, 100) : null;
    const text = String(message).slice(0, 600);
    const id = createHash('sha256').update(JSON.stringify([code, source, phase, code.endsWith('_WAITING') ? '' : text])).digest('hex').slice(0, 16);
    const now = this.now();
    const existing = this.pending.get(id);
    this.pending.set(id, {
      id, code, level: level === 'error' ? 'error' : 'warning', path: source, stage: phase,
      message: text, first: existing?.first ?? now, last: now, repeats: (existing?.repeats || 0) + 1,
    });
    if (this.pending.size >= 500) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_AFTER).unref();
    return id;
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.size) return;
    let writing = false;
    try {
      this.sql.exec('BEGIN IMMEDIATE');
      writing = true;
      for (const r of this.pending.values()) this.save.run(r.id, r.code, r.level, r.path, r.stage, r.message, r.first, r.last, r.repeats);
      this.sql.exec('COMMIT');
      this.pending.clear();
      this.lastWriteError = null;
    } catch (error) {
      if (writing && this.sql.isTransaction) this.sql.exec('ROLLBACK');
      if (error.message !== this.lastWriteError) console.error('[stream] Cannot save dashboard notifications:', error.message);
      this.lastWriteError = error.message;
      for (const id of this.pending.keys()) {
        if (this.pending.size <= 500) break;
        this.pending.delete(id);
      }
    }
  }

  page({ offset = 0, limit = 40 } = {}) {
    this.flush();
    const rows = this.sql.prepare(`SELECT id,code,level,path,stage,message,
      first_at AS firstAt,last_at AS lastAt,occurrences,read_at IS NULL AS unread
      FROM diagnostic_issues ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit + 1, offset);
    const unread = this.sql.prepare('SELECT COUNT(*) AS count FROM diagnostic_issues WHERE read_at IS NULL').get().count;
    return { issues: rows.slice(0, limit), unread, nextOffset: rows.length > limit ? offset + limit : null,
      storageError: this.lastWriteError || null };
  }

  markRead() {
    this.flush();
    return this.sql.prepare('UPDATE diagnostic_issues SET read_at=? WHERE read_at IS NULL').run(this.now()).changes;
  }

  tick(scanner, coordinator) {
    const current = new Set();
    const now = this.now();
    const track = (key, task, code) => {
      current.add(key);
      const bytes = task.bytesRead;
      const previous = this.watched.get(key);
      const started = Date.parse(task.startedAt);
      const record = previous || { lastProgress: Number.isFinite(started) ? started : now, bytes };
      if (bytes !== record.bytes) {
        record.lastProgress = now;
        record.bytes = bytes;
      }
      if (!record.notified && now - record.lastProgress >= this.warnAfter) {
        record.notified = true;
        this.record({ code, path: task.path, stage: task.stage, message: 'This operation has not reported progress for ' +
          Math.floor((now - record.lastProgress) / 1000) + ' seconds.' });
      }
      this.watched.set(key, record);
    };
    for (const [id, task] of scanner.active) track(id, task, 'SCAN_TASK_WAITING');
    if (scanner.progress && !scanner.active.size) {
      const p = scanner.progress;
      track('scan:' + p.startedAt + ':' + p.lastProgressAt,
        { path: p.folder, stage: p.phase, startedAt: p.lastProgressAt }, 'SCAN_WAITING');
    }
    for (const { task } of coordinator.active.values()) {
      if (task.persistent !== false) track('work:' + task.id,
        { path: task.path, stage: task.kind, startedAt: task.startedAt }, 'BACKGROUND_TASK_WAITING');
    }
    for (const id of this.watched.keys()) if (!current.has(id)) this.watched.delete(id);
  }

  async checkDisk(directory, stage) {
    try {
      const { freeBytes: free } = await filesystemCapacity(directory);
      this.diskErrors?.delete(stage);
      const constrained = free < 1024n ** 3n;
      this.lowSpace ??= new Set();
      if (constrained && !this.lowSpace.has(stage)) {
        this.record({ code: 'LOW_DISK_SPACE', stage, message: 'Less than 1 GiB remains on the app storage filesystem.' });
        this.lowSpace.add(stage);
      }
      if (!constrained) this.lowSpace.delete(stage);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.diskErrors ??= new Set();
      if (this.diskErrors.has(stage)) return;
      this.diskErrors.add(stage);
      this.record({ code: 'DISK_STATUS_UNAVAILABLE', stage, message: error.code || 'Could not inspect the disk' });
    }
  }

  start(scanner, coordinator, cfg) {
    let counter = 0;
    this.timer = setInterval(() => {
      this.tick(scanner, coordinator);
      if ((counter++ % 12) === 0 && !this.diskCheck) {
        this.diskCheck = Promise.all([this.checkDisk(cfg.dataDir, 'catalog'), this.checkDisk(cfg.cacheSnapshotDir || cfg.cacheDir, 'cache')])
          .finally(() => { this.diskCheck = null; });
      }
    }, 5000).unref();
  }

  stop() {
    clearInterval(this.timer);
    this.stopped = true;
    this.flush();
  }
}

module.exports = { Diagnostics };
