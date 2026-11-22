'use strict';
const { filesystemCapacity } = require('./filesystem-capacity');

const { createHash } = require('node:crypto');
const { posix } = require('node:path');

const WARN_AFTER = 60_000;
const FLUSH_AFTER = 500;
const MEDIA_REPAIR = "path IS NOT NULL AND (code IN ('SCAN_FILE_FAILED','MEDIA_REPAIR_REQUESTED') OR (code='BACKGROUND_TASK_FAILED' AND COALESCE(stage,'')='playback'))";
const REPAIR_KIND = "CASE WHEN stage='playback' AND code<>'SCAN_FILE_FAILED' THEN 'playback' ELSE 'scan' END";
const ISSUE_COLUMNS = 'id,code,level,path,stage,message,first_at AS firstAt,last_at AS lastAt,occurrences,read_at IS NULL AS unread';

const categories = new Map([
  ['media', '((' + MEDIA_REPAIR + ") OR code='SCAN_UNSUPPORTED_FORMAT')"],
  ['scanning', "code GLOB 'SCAN_*' AND code NOT IN ('SCAN_FILE_FAILED','SCAN_UNSUPPORTED_FORMAT','SCAN_STORAGE_UNRESPONSIVE')"],
  ['storage', "code GLOB '*CACHE*' OR code GLOB '*DISK*' OR code GLOB '*STORAGE*'"],
  ['nodes', "code GLOB 'NODE_*'"],
]);
categories.set('system', 'NOT (' + [...categories.values()].map(clause => '(' + clause + ')').join(' OR ') + ')');

categories.set('operations', 'NOT (' + categories.get('media') + ')');
function scopeFor({ generalOnly, category, errorsOnly }) {
  return [generalOnly && 'NOT (' + MEDIA_REPAIR + ')', categories.get(category),
    errorsOnly && "(level='error' OR code='SCAN_FILE_FAILED')"].filter(Boolean).map(part => '(' + part + ')').join(' AND ') || '1=1';
}

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
      CREATE INDEX IF NOT EXISTS diagnostic_general_unread ON diagnostic_issues(id)
        WHERE read_at IS NULL AND NOT (${MEDIA_REPAIR});
      CREATE INDEX IF NOT EXISTS diagnostic_general_recent ON diagnostic_issues(last_at DESC,id DESC)
        WHERE NOT (${MEDIA_REPAIR});
      CREATE INDEX IF NOT EXISTS diagnostic_repair_paths ON diagnostic_issues(path,code,last_at DESC,id DESC)
        WHERE ${MEDIA_REPAIR};
      CREATE INDEX IF NOT EXISTS diagnostic_repair_source ON diagnostic_issues(path,last_at DESC,id DESC) WHERE ${MEDIA_REPAIR};
      CREATE INDEX IF NOT EXISTS diagnostic_repair_recent ON diagnostic_issues(last_at DESC,id DESC) WHERE ${MEDIA_REPAIR};
      CREATE TABLE IF NOT EXISTS diagnostic_repairs (
        issue_id TEXT PRIMARY KEY, state TEXT NOT NULL, message TEXT NOT NULL
      );
    `);
    this.sql.prepare("UPDATE diagnostic_repairs SET state='interrupted',message=? WHERE state='running'")
      .run('VidStream restarted before this repair finished. Select Repair to try again.');
    this.findIssue = this.sql.prepare('SELECT id,code,path,stage FROM diagnostic_issues WHERE id=?');
    this.findRepairIssue = this.sql.prepare(`SELECT ${ISSUE_COLUMNS} FROM diagnostic_issues WHERE id=? AND (${MEDIA_REPAIR})`);
    this.findSourceIssue = this.sql.prepare(`SELECT id FROM diagnostic_issues WHERE path=? AND (${MEDIA_REPAIR}) AND (${REPAIR_KIND})=?
      ORDER BY last_at DESC,id DESC LIMIT 1`);
    this.findRepairPage = this.sql.prepare(`
      SELECT ${ISSUE_COLUMNS} FROM diagnostic_issues AS entry WHERE (${MEDIA_REPAIR})
        AND id=(SELECT id FROM diagnostic_issues WHERE path=entry.path AND (${MEDIA_REPAIR})
          AND (${REPAIR_KIND})=(CASE WHEN entry.stage='playback' AND entry.code<>'SCAN_FILE_FAILED' THEN 'playback' ELSE 'scan' END)
          ORDER BY last_at DESC,id DESC LIMIT 1)
      ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?
    `);
    this.findRepair = this.sql.prepare('SELECT state,message FROM diagnostic_repairs WHERE issue_id=?');
    this.clearCompletedRepair = this.sql.prepare("DELETE FROM diagnostic_repairs WHERE issue_id=? AND state='completed'");
    this.saveRepair = this.sql.prepare(`
      INSERT INTO diagnostic_repairs (issue_id,state,message) VALUES (?,?,?)
      ON CONFLICT(issue_id) DO UPDATE SET state=excluded.state,message=excluded.message
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
      id, code, level: level === 'error' || level === 'info' ? level : 'warning', path: source, stage: phase,
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
      for (const r of this.pending.values()) {
        this.save.run(r.id, r.code, r.level, r.path, r.stage, r.message, r.first, r.last, r.repeats);
        if (r.code === 'SCAN_FILE_FAILED' || (r.code === 'BACKGROUND_TASK_FAILED' && r.stage === 'playback'))
          this.clearCompletedRepair.run(r.id);
      }
      this.sql.exec('COMMIT');
      this.pending.clear();
      this._unread = null;
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

  page({ offset = 0, limit = 40, ...filters } = {}) {
    this.flush();
    const scope = scopeFor(filters);
    const rows = this.sql.prepare(`SELECT ${ISSUE_COLUMNS}
      FROM diagnostic_issues WHERE ${scope}
      ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit + 1, offset);
    const unread = this.unreadCount();
    return { issues: rows.slice(0, limit), unread, nextOffset: rows.length > limit ? offset + limit : null,
      storageError: this.lastWriteError || null };
  }

  unreadCount() {
    this.flush();
    return this._unread ??= this.sql.prepare('SELECT COUNT(*) AS count FROM diagnostic_issues WHERE read_at IS NULL').get().count;
  }

  markRead(filters = {}) {
    this.flush();
    this._unread = null;
    if (typeof filters === 'boolean') filters = { generalOnly: filters };
    return this.sql.prepare('UPDATE diagnostic_issues SET read_at=? WHERE read_at IS NULL AND ' + scopeFor(filters)).run(this.now()).changes;
  }

  manualRepair(path, kind) {
    this.flush();
    return this.findSourceIssue.get(path, kind)?.id || this.record({ code: 'MEDIA_REPAIR_REQUESTED', level: 'info',
      stage: kind, path, message: kind === 'playback' ? 'Owner requested a compatible playback copy.' : 'Owner requested a rebuild of the preview and catalog entry.' });
  }

  issue(id) {
    this.flush();
    return this.findIssue.get(id);
  }

  repairPage({ offset, limit }) {
    this.flush();
    const rows = this.findRepairPage.all(limit + 1, offset);
    return { issues: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
      storageError: this.lastWriteError || null };
  }

  repairIssue(id) {
    this.flush();
    return this.findRepairIssue.get(id);
  }

  recoveryCandidates() {
    this.flush();
    return this.sql.prepare(`
      WITH ranked AS (
        SELECT i.id,i.code,i.stage,i.path,i.last_at,r.state,
          ROW_NUMBER() OVER (PARTITION BY i.path,(CASE WHEN i.stage='playback' AND i.code<>'SCAN_FILE_FAILED' THEN 'playback' ELSE 'scan' END) ORDER BY i.last_at DESC,i.id DESC) AS latest
        FROM diagnostic_issues i LEFT JOIN diagnostic_repairs r ON r.issue_id=i.id
        WHERE i.path IS NOT NULL AND (i.code IN ('SCAN_FILE_FAILED','MEDIA_REPAIR_REQUESTED')
          OR (i.code='BACKGROUND_TASK_FAILED' AND i.stage='playback'))
      )
      SELECT id,code,stage,path FROM ranked
      WHERE latest=1 AND COALESCE(state,'') NOT IN ('running','completed')
      ORDER BY last_at DESC,id DESC
    `).all();
  }

  repairStatus(id) {
    return this.findRepair.get(id) || null;
  }

  setRepair(id, state, message) {
    this.flush();
    this.saveRepair.run(id, state, String(message).slice(0, 600));
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
    if (scanner.progress && !scanner.active.size && !scanner.pauseState?.()) {
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
