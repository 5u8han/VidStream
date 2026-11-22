'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('node:crypto');
const { digest, commitFile } = require('./durable-files');
const { slugFor } = require('./slug');
const { Queue } = require('./queue');
const { scanCommands } = require('./scan-command');
const { ScanGuard, STORAGE_UNRESPONSIVE } = require('./scan-guard');
const { processPhoto } = require('./media-photo');
const { processVideo } = require('./media-video');
const { ARCHIVE_DIRECTORY, PORTABLE_STORAGE_DIRECTORY } = require('./catalog');
const { folders, normalizePath } = require('./folder-collections');
const { resourceLimits } = require('./hardware-limits');
const { resolveMediaSource } = require('./serve-file');
const { fileIdentity, canReuseHash, assertSameSource } = require('./scan-source');

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.tif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.nomedia']);
const ERROR_SAMPLES = 100;
const LOG_CAPACITY = 160;
const ACTIVITY_CAPACITY = 60;
const SCAN_STATE = 'scanState';
const ROOT_SCOPE_PREFIX = 'roots-v1:';
const STORAGE_TIMEOUT_MS = 45_000;
const STAGE_TIMEOUT_MS = 10 * 60_000;
const SCAN_LOG_INTERVAL_MS = 5 * 60_000;
const MiB = 1024 ** 2;

function scannerWorkerCount(cfg, limits = resourceLimits()) {
  const multiplier = cfg.scanWorkerMultiplier === 2 ? 2 : 1;
  const available = Math.min(64, Math.max(1, Math.ceil(limits.effectiveCores))) * multiplier;
  const reserved = Number(cfg.cacheRamBudgetBytes) || 0;
  const memoryBudget = Math.max(1, Math.floor((limits.effectiveMemoryBytes - reserved - 512 * MiB) / (384 * MiB)));
  const requested = Number(cfg.processingConcurrency);
  const budget = Number.isInteger(requested) && requested > 0 ? requested : available;
  return Math.min(available, memoryBudget, budget);
}

function classify(ext) {
  const e = ext.toLowerCase();
  if (PHOTO_EXTS.has(e)) return 'photo';
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}

function idleCounts() {
  return { directories: 0, files: 0, photos: 0, videos: 0, unsupported: 0, failed: 0, unreadableDirectories: 0 };
}

function forParents(relative, visit) {
  for (let key = relative;; key = path.posix.dirname(key)) {
    if (key === '.' || key === '/') key = '';
    visit(key);
    if (!key) return;
  }
}

function updateReports(reports, relative, kind) {
  forParents(relative, key => {
    const report = reports.get(key);
    if (report) report[kind]++;
  });
}

function* importOrder(files, mediaFolders) {
  if (!mediaFolders || mediaFolders.length < 2) {
    yield* files;
    return;
  }
  const byFolder = new Map(mediaFolders.map(name => [name, []]));
  for (const file of files) byFolder.get(file.relPath.split('/', 1)[0]).push(file);
  const active = [...byFolder.values()].filter(group => group.length).map(group => ({ group, index: 0 }));
  for (let cursor = 0; active.length; cursor %= active.length || 1) {
    const item = active[cursor];
    yield item.group[item.index++];
    if (item.index === item.group.length) active.splice(cursor, 1);
    else cursor++;
  }
}

async function bounded(items, limit, visit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) await visit(items[next++]);
  });
  const results = await Promise.allSettled(workers);
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

class PendingWork {
  count = 0;
  add(task) {
    this.count++;
    task.then(() => this.done(), error => {
      this.error ??= error;
      this.done();
    });
  }
  done() {
    this.count--;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
  async next() {
    if (this.count > 0) await new Promise(resolve => { this.waiter = resolve; });
  }
  async drain() {
    while (this.count) await this.next();
    if (this.error) throw this.error;
  }
}

async function hasArchivedOriginal(root, item, filesystem) {
  if (!item.relPath || path.isAbsolute(item.relPath) || item.relPath.split('/').includes('..')) return false;
  return filesystem(async () => {
    try {
      const archive = path.join(await fsp.realpath(root), path.dirname(item.relPath), ARCHIVE_DIRECTORY);
      if (path.relative(archive, await fsp.realpath(archive))) return false;
      const stat = await fsp.lstat(path.join(archive, path.basename(item.relPath)));
      return stat.isFile() && stat.size === item.size && stat.mtime.toISOString() === item.mtime;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  });
}

async function derivativePaths(cfg, staging, id, type, stage) {
  const root = stage === 'analysis' ? cfg.cacheDir : staging;
  const sized = kind => (width, ext) => path.join(root, kind, String(width), id + ext);
  if (stage === 'basic' || stage === 'preview') {
    const kind = stage === 'basic' ? (type === 'photo' ? 'thumb' : 'poster') : (type === 'photo' ? 'large' : 'preview');
    const widths = { thumb: cfg.thumbnailSizes, poster: cfg.posterSizes, large: cfg.largeSizes, preview: [''] }[kind];
    for (const width of widths) await fsp.mkdir(path.join(root, kind, String(width)), { recursive: true });
  }
  return {
    thumb: sized('thumb'),
    large: sized('large'),
    poster: sized('poster'),
    preview: ext => path.join(root, 'preview', id + ext),
  };
}

async function promoteDerivatives(staging, cacheDir, derivativeCache) {
  async function promote(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) await promote(source);
      else if (entry.isFile()) {
        if ((await fsp.stat(source)).size === 0) throw Error('Generated derivative is empty');
        const dest = path.join(cacheDir, path.relative(staging, source));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const move = () => commitFile(source, dest);
        if (derivativeCache && path.relative(cacheDir, dest).split(path.sep)[0] === 'preview')
          await derivativeCache.withLease(dest, move);
        else await move();
      }
    }
  }
  await promote(staging);
}

function removeDerivatives(cacheDir, id) {
  for (const kind of ['thumb', 'large', 'poster']) {
    const kindDir = path.join(cacheDir, kind);
    let widthDirs;
    try {
      widthDirs = fs.readdirSync(kindDir);
    } catch {
      continue;
    }
    for (const w of widthDirs) {
      const dir = path.join(kindDir, w);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.startsWith(id + '.')) {
          try { fs.unlinkSync(path.join(dir, f)); } catch { }
        }
      }
    }
  }
  const previewDir = path.join(cacheDir, 'preview');
  try {
    for (const f of fs.readdirSync(previewDir)) {
      if (f.startsWith(id + '.')) {
        try { fs.unlinkSync(path.join(previewDir, f)); } catch { }
      }
    }
  } catch { }
}

function processingConfigFingerprint(cfg) {
  return JSON.stringify([
    "metadata-preview-v2", cfg.thumbnailSizes, cfg.largeSizes, cfg.posterSizes,
    cfg.videoPreviewDuration, cfg.videoPreviewMaxWidth, cfg.videoPreviewFps,
    cfg.enableFaceDetection, cfg.enablePetDetection,
    cfg.enableOcr, cfg.enableDuplicateDetection, cfg.enableObjectDetection, cfg.objectModelPath, cfg.objectDevice,
  ]);
}

function rootScope(sources) {
  const ids = sources.map(({ root, device, inode, created }) =>
    [root, inode, created ? 'created:' + created : 'device:' + device]).sort();
  return ROOT_SCOPE_PREFIX + crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function processingRecipes(cfg, type) {
  return {
    basic: JSON.stringify(['metadata-poster-v3', type === 'photo' ? cfg.thumbnailSizes : cfg.posterSizes]),
    preview: JSON.stringify(['preview-v3', ...(type === 'photo' ? [cfg.largeSizes] : [cfg.videoPreviewDuration, cfg.videoPreviewMaxWidth, cfg.videoPreviewFps])]),
    analysis: JSON.stringify(['analysis-v3', cfg.enableFaceDetection, cfg.enablePetDetection, cfg.enableOcr,
      cfg.enableDuplicateDetection, cfg.enableObjectDetection, cfg.objectModelPath, cfg.objectDevice]),
  };
}

async function missingRepresentations(cfg, item) {
  const exists = async file => { try { return (await fsp.stat(file)).size > 0; } catch { return false; } };
  const basicFiles = item.type === 'photo'
    ? cfg.thumbnailSizes.map(width => path.join(cfg.cacheDir, 'thumb', String(width), item.id + (item.thumbExt || '.jpg')))
    : cfg.posterSizes.map(width => path.join(cfg.cacheDir, 'poster', String(width), item.id + '.jpg'));
  const evictable = cfg.cacheMaxBytes > 0 && !cfg.cacheSnapshotDir && item.type === 'video' && item.processing?.previewReady;
  const previewFiles = evictable ? [] : item.type === 'photo'
    ? cfg.largeSizes.map(width => path.join(cfg.cacheDir, 'large', String(width), item.id + (item.largeExt || '.jpg')))
    : [path.join(cfg.cacheDir, 'preview', item.id + '.mp4')];
  const [basic, preview] = await Promise.all([Promise.all(basicFiles.map(exists)), Promise.all(previewFiles.map(exists))]);
  return { basic: basic.some(value => !value), preview: preview.some(value => !value) };
}

function summarizeError(err, mediaDir) {
  const raw = (err && err.stderr ? String(err.stderr) : '') || (err && err.message) || 'unknown error';
  let line = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || raw;
  line = line.replace(/^[\w.-]+:\s*/, '').replace(/\s*@\s*error\/\S+/, '');
  if (mediaDir) line = line.split(mediaDir + '/').join('');
  return line.slice(0, 200);
}

class Scanner {
  constructor(cfg, db, { onLog = () => {}, onIssue = () => {}, onChange = () => {}, coordinator = null,
    storageTimeout = STORAGE_TIMEOUT_MS, stageTimeout = STAGE_TIMEOUT_MS } = {}) {
    this.cfg = cfg;
    this.db = db;
    this.mediaFolders = db.mediaFolders ?? null;
    this.onLog = onLog;
    this.onIssue = onIssue;
    this.onChange = onChange;
    this.coordinator = coordinator;
    const limits = resourceLimits();
    this.workers = scannerWorkerCount(cfg, limits);
    this.readers = Math.min(64, Math.max(1, this.workers * 2),
      cfg.scanReadConcurrency || Math.min(this.workers, 4));
    this.statWorkers = Math.min(128, Math.max(4, this.readers * 4));
    this.directoryWorkers = Math.min(32, this.statWorkers);
    this.parallelism = {
      workers: this.workers, readers: this.readers, metadataWorkers: this.statWorkers,
      directoryWorkers: this.directoryWorkers, workerMultiplier: cfg.scanWorkerMultiplier ?? 1,
      effectiveCores: limits.effectiveCores, memoryBytes: limits.effectiveMemoryBytes,
      cacheRamBytes: cfg.cacheRamBudgetBytes || 0,
    };
    this.queue = new Queue(this.workers);
    this.repairQueue = new Queue(1);
    this.repairs = new Map();
    this.repairingPath = null;
    this.writingStage = new Map();
    this.admittedIds = new Map();
    this.scanning = false;
    this.scanPause = null;
    this.progress = null;
    this.stopping = false;
    this.watchers = new Map();
    this.pending = new Map();
    this.logs = [];
    this.storage = new AbortController();
    this.storageTimeout = storageTimeout;
    this.stageTimeout = stageTimeout;
    this.guard = new ScanGuard(this.storage.signal);
    this.active = new Map();
    this.recentActivities = [];
    const cached = [...db.items.values()].filter(item => item.availability !== 'archived');
    this.stats = {
      photoCount: cached.filter(item => item.type === 'photo').length,
      videoCount: cached.filter(item => item.type === 'video').length,
      unsupportedCount: 0, failedCount: 0, unreadableDirectoryCount: 0, total: cached.length,
    };
    this.unsupported = [];
    this.failed = [];
    this.walkErrors = [];
    const saved = db.store?.setting?.(SCAN_STATE, {});
    const oldHistory = path.join(cfg.cacheDir, 'scan-history.json');
    if (Array.isArray(saved?.logs)) this.logs = saved.logs.slice(-LOG_CAPACITY);
    if (Array.isArray(saved?.recentActivities)) this.recentActivities = saved.recentActivities.slice(-ACTIVITY_CAPACITY);
    this.history = saved?.history;
    if (!Array.isArray(this.history)) {
      try { this.history = JSON.parse(fs.readFileSync(oldHistory, 'utf8')).slice(-30); }
      catch { this.history = []; }
    }
    this.lastScan = this.history.at(-1) || null;
    this.lastFullScan = (saved?.lastFullScan?.scope ? saved.lastFullScan : this.history.findLast(scan => scan.scope)) ?? null;
    this.reports = new Map(saved?.reports || []);
    this.issuesByDirectory = new Map(saved?.issuesByDirectory || []);
    for (const kind of ['unsupported', 'failed', 'walkErrors'])
      if (Array.isArray(saved?.samples?.[kind])) this[kind] = saved.samples[kind].slice(0, ERROR_SAMPLES);
    this._updateIssueCounts();
    if (saved?.running) {
      this.warn('SCAN_INTERRUPTED', 'The previous scan ended before it could finish. Catalog changes already saved can be reused.');
      const interrupted = { at: new Date().toISOString(), status: 'interrupted', startedAt: saved.running.startedAt };
      for (const key of saved.running.reportPaths) {
        this.reports.set(key, { ...idleCounts(), ...interrupted, previous: this.previousReport(key) });
      }
      this._persist(null);
    }
  }

  log(level, message, issueId) {
    const row = { at: new Date().toISOString(), level, message: String(message).slice(0, 400),
      ...(issueId ? { issueId } : {}) };
    this.logs.push(row);
    if (this.logs.length > LOG_CAPACITY) this.logs.shift();
    this.onLog(row.message);
  }

  notify(issue) {
    try { return this.onIssue(issue); }
    catch (error) { this.onLog('Could not record scan notification: ' + summarizeError(error)); }
  }

  warn(code, message, path = null, stage = null, level = 'warn') {
    this.log(level, message);
    this.notify({ level, code, message, path, stage });
  }

  previousReport(key) {
    const last = this.reports.get(key);
    if (!last) return null;
    const { previous, ...report } = last;
    return report.status === 'interrupted' ? previous || null : report;
  }

  _persist(running) {
    try {
      this.db.store?.setSetting?.(SCAN_STATE, {
        history: this.history, lastFullScan: this.lastFullScan, reports: [...this.reports],
        issuesByDirectory: [...this.issuesByDirectory], running,
        samples: { unsupported: this.unsupported, failed: this.failed, walkErrors: this.walkErrors },
        logs: this.logs, recentActivities: this.recentActivities,
      });
    } catch (error) {
      this.warn('SCAN_STATE_SAVE_FAILED', 'Could not save scan history: ' + summarizeError(error, this.cfg.mediaDir));
    }
  }

  _updateIssueCounts() {
    const totals = { unsupported: 0, failed: 0, walkErrors: 0 };
    for (const counts of this.issuesByDirectory.values()) {
      for (const kind of Object.keys(totals)) totals[kind] += counts[kind] || 0;
    }
    this.stats.unsupportedCount = totals.unsupported;
    this.stats.failedCount = totals.failed;
    this.stats.unreadableDirectoryCount = totals.walkErrors;
    this.stats.total = this.stats.photoCount + this.stats.videoCount + totals.unsupported + totals.failed;
  }

  _filesystem(action) { return this.guard.run(this.storageTimeout, null, null, action); }

  skipActiveFile(id) {
    return this.scanning && !this.stopping && this.guard.skip(id);
  }

  _folder(folder) {
    if (folder === null) return null;
    const normalized = normalizePath(folder);
    if (normalized.split('/').some(segment => segment.startsWith('.') || segment === PORTABLE_STORAGE_DIRECTORY))
      throw Error('Choose a visible media folder');
    if (this.mediaFolders !== null &&
        (!normalized || !this.mediaFolders.includes(normalized.split('/', 1)[0])))
      throw Error('Choose a folder inside a selected media mount');
    return normalized;
  }

  status() {
    const paths = new Set(folders(this.db).map(entry => entry.path));
    if (this.reports.has('')) paths.add('');
    const progress = this.progress ? { ...this.progress, active: [...this.active.values()],
      recentActivities: this.recentActivities, pauseState: this.pauseState() } : null;
    return {
      stats: this.stats, unsupported: this.unsupported, failed: this.failed, walkErrors: this.walkErrors,
      lastScan: this.lastScan, scanning: this.scanning, progress, logs: this.logs,
      recentActivities: progress ? [] : this.recentActivities,
      folders: [...paths].map(folder => ({ path: folder, lastScan: this.reports.get(folder) || null })),
      queued: [...this.pending.values()],
      repairWork: { activePath: this.repairingPath, waiting: this.repairs.size - (this.repairingPath ? 1 : 0) },
      parallelism: { ...this.parallelism, preset: this.coordinator?.preset,
        processingLimit: this.coordinator?.capacity[this.coordinator.preset] ?? this.workers },
      pendingStorageReads: this.guard.unsettled.size,
    };
  }

  pauseState() {
    return this.scanPause ? (this.active.size ? 'pausing' : 'paused') : null;
  }

  setScanPaused(paused) {
    if (!this.scanning || this.stopping)
      throw Object.assign(new Error('There is no active scan to pause or resume.'), { status: 409 });
    if (paused && !this.scanPause) {
      let resume;
      const wait = new Promise(resolve => { resume = resolve; });
      this.scanPause = { wait, resume };
      this.log('info', 'Scan pause requested. Active operations can finish.');
    } else if (!paused && this.scanPause) {
      this._releaseScanPause();
      this.progress.lastProgressAt = new Date().toISOString();
      this.log('info', 'Scan resumed.');
      this.coordinator?.pump();
    }
    return this.pauseState();
  }

  _releaseScanPause() {
    const pause = this.scanPause;
    this.scanPause = null;
    pause?.resume();
  }

  async _waitForScan() {
    while (this.scanPause) await this.scanPause.wait;
  }

  startScan({ force = false, folder = null } = {}) {
    folder = this._folder(folder);
    if (this.stopping || this.editing)
      return { started: false, queued: false, folder, reason: this.stopping ? 'stopping' : 'editing' };
    if (this.scanning) {
      const pending = this.pending.get(folder);
      this.pending.set(folder, { folder, force: force || pending?.force === true });
      if (!pending) this.log('info', 'Queued a scan for ' + this._label(folder) + '.');
      return { started: false, queued: true, folder };
    }
    this.scan({ force, folder }).catch(() => {});
    return { started: true, queued: false, folder };
  }

  _label(folder) { return folder ? '“' + folder + '”' : 'the full library'; }

  _phase(phase) {
    this.progress.phase = phase;
    this.progress.lastProgressAt = new Date().toISOString();
  }

  async _work(stage, relative, action, foreground = false) {
    if (!foreground && this.scanPause) await this._waitForScan();
    if (this.stopping) throw Error('Scan interrupted');
    const token = Symbol(stage);
    const startedAt = new Date().toISOString();
    const task = { path: relative, stage, startedAt, lastProgressAt: startedAt };
    if (foreground) return action(task);
    this.active.set(token, task);
    let outcome = 'completed';
    try { return await action(task); }
    catch (error) {
      outcome = ['SCAN_FILE_SKIPPED', 'REPAIR_SUPERSEDED_SCAN'].includes(error.code) ? 'skipped' : error.code === 'SCAN_TASK_TIMEOUT' ? 'timed-out' : 'failed';
      throw error;
    }
    finally {
      this.active.delete(token);
      if (this.progress) {
        const finishedAt = new Date().toISOString();
        this.recentActivities.push({ ...task, finishedAt, outcome });
        if (this.recentActivities.length > ACTIVITY_CAPACITY) this.recentActivities.shift();
        this.progress.lastProgressAt = finishedAt;
      }
    }
  }

  _hashSource(file, stat, foreground = false) {
    const progress = !foreground && this.progress;
    return this._work('reading and hashing source', file.relPath, task => {
      let lastUpdate = Date.now();
      task.bytesRead = 0;
      task.size = stat.size;
      return this.guard.run(this.storageTimeout, task, null, (signal, touch) =>
        digest(file.full, { signal, onRead: bytes => {
          if (signal.aborted) return;
          touch();
          const lastRead = Date.now();
          task.bytesRead += bytes;
          if (progress) progress.bytesRead += bytes;
          if (lastRead - lastUpdate >= 1_000) {
            lastUpdate = lastRead;
            task.lastProgressAt = new Date(lastRead).toISOString();
            if (progress) progress.lastProgressAt = task.lastProgressAt;
          }
        } }));
    }, foreground);
  }

  async _walkMedia(roots, out) {
    const root = this.cfg.mediaDir;
    const queue = [...roots];
    const width = this.directoryWorkers;
    const rootSet = new Set(roots);
    const readDirectory = relDir => this._work('directory', relDir, async () => {
      const dir = path.join(root, relDir);
      const entries = await this._filesystem(async () => {
        if (rootSet.has(relDir) && relDir) {
          let current = root;
          for (const segment of relDir.split('/')) {
            current = path.join(current, segment);
            if (!(await fsp.lstat(current)).isDirectory())
              throw Error('Mounted media folder is no longer a directory');
          }
        }
        return fsp.readdir(dir, { withFileTypes: true });
      });
      this.progress.directories++;
      updateReports(out.reports, relDir, 'directories');
      for (const entry of entries) {
        if (this.stopping) return;
        const name = entry.name;
        if (name.startsWith('.') || name === PORTABLE_STORAGE_DIRECTORY) continue;
        const relPath = relDir ? relDir + '/' + name : name;
        if (entry.isDirectory()) {
          queue.push(relPath);
          continue;
        }
        if (!entry.isFile() || IGNORED_FILES.has(name.toLowerCase())) continue;
        this.progress.files++;
        updateReports(out.reports, relDir, 'files');
        const ext = path.extname(name);
        const type = classify(ext);
        if (!type) {
          if (ext) out.issue('unsupported', relPath, ext);
          continue;
        }
        this.progress.discovered++;
        updateReports(out.reports, relDir, type === 'photo' ? 'photos' : 'videos');
        out.found.push({ full: path.join(dir, name), relPath, ext, type });
      }
    });
    let next = 0;
    const active = new PendingWork();
    while (((!this.stopping && !active.error) && next < queue.length) || active.count) {
      if (this.scanPause) await this._waitForScan();
      while (!this.stopping && !active.error && next < queue.length && active.count < width) {
        const directory = queue[next++];
        active.add(readDirectory(directory).catch(error => {
          if (error.code === STORAGE_UNRESPONSIVE) throw error;
          out.issue('walkErrors', directory, summarizeError(error, root));
        }));
      }
      await active.next();
    }
    await active.drain();
  }

  async scan({ force = false, folder = null } = {}) {
    if (this.stopping || this.scanning || this.editing) return { skipped: true };
    folder = this._folder(folder);
    const roots = folder === null && this.mediaFolders ? this.mediaFolders : [folder || ''];
    const matches = relative => folder === null || !folder || relative.startsWith(folder + '/');
    const matchesIssue = relative => relative === folder || matches(relative);
    const reportPaths = new Set([...roots, ...folders(this.db).map(entry => entry.path).filter(key =>
      folder === null || !folder || key === folder || key.startsWith(folder + '/'))]);
    const reports = new Map([...reportPaths].map(key => [key, idleCounts()]));
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    this.scanning = true;
    const repairPaths = this.scanRepairPaths = new Set(this.repairs.keys());
    this.recentActivities = [];
    const progress = this.progress = {
      phase: 'discovering', folder, startedAt, lastProgressAt: startedAt,
      discovered: 0, directories: 0, files: 0, examined: 0, processed: 0, reconciled: 0, bytesRead: 0,
    };
    this._scanSettled = new Promise(resolve => { this._resolveScan = resolve; });

    let added = 0;
    let updated = 0;
    let removed = 0;
    let status = 'interrupted';
    let scope = null;
    const found = [];
    const unreadable = new Set();
    const samples = { unsupported: [], failed: [], walkErrors: [] };
    const issuesByDirectory = new Map();
    const fileFailures = new Map();
    const totals = { unsupported: 0, failed: 0, walkErrors: 0 };
    const progressLog = setInterval(() => {
      if (this.stopping || this.scanPause) return;
      const idleSeconds = Math.floor((Date.now() - Date.parse(progress.lastProgressAt)) / 1000);
      const active = this.active.values().next().value;
      this.log('info', 'Scan ' + progress.phase + ': ' + progress.discovered + ' discovered, ' +
        progress.processed + ' checked, ' + totals.failed + ' file failures, ' + totals.walkErrors +
        ' directory errors. ' + this.active.size + ' active' + (active ? ' (oldest: ' + active.stage + ')' : '') +
        '. Last progress ' + idleSeconds + 's ago.');
    }, SCAN_LOG_INTERVAL_MS).unref();
    const issue = (kind, relPath, detail, stage = this.progress?.phase) => {
      totals[kind]++;
      const directory = kind === 'walkErrors' ? relPath : path.posix.dirname(relPath);
      updateReports(reports, directory, kind === 'walkErrors' ? 'unreadableDirectories' : kind);
      const directoryKey = directory === '.' ? '' : directory;
      const counts = issuesByDirectory.get(directoryKey) || {};
      counts[kind] = (counts[kind] || 0) + 1;
      issuesByDirectory.set(directoryKey, counts);
      if (kind === 'failed') fileFailures.set(relPath, (fileFailures.get(relPath) || 0) + 1);
      if (kind === 'walkErrors') unreadable.add(relPath);
      if (samples[kind].length < ERROR_SAMPLES)
        samples[kind].push({ relPath, [kind === 'unsupported' ? 'ext' : 'error']: detail });
      const code = kind === 'walkErrors' ? 'SCAN_DIRECTORY_UNREADABLE'
        : kind === 'unsupported' ? 'SCAN_UNSUPPORTED_FORMAT' : 'SCAN_FILE_FAILED';
      const message = kind === 'unsupported' ? 'Unsupported file format: ' + detail : detail;
      const issueId = !this.stopping && this.notify({ level: kind === 'failed' ? 'error' : 'warn', code, message, path: relPath, stage });
      if (kind !== 'unsupported' && totals[kind] <= ERROR_SAMPLES)
        this.log('warn', (relPath || 'Media root') + ': ' + detail, kind === 'failed' ? issueId : null);
      if (kind !== 'unsupported' && totals[kind] === ERROR_SAMPLES)
        this.log('info', 'The first ' + ERROR_SAMPLES + (kind === 'failed' ? ' file failures' : ' directory errors') +
          ' have been logged. Further issues go to Dashboard. Scan totals will continue here every five minutes.');
    };
    this.resolveCurrentFailure = relPath => {
      const count = fileFailures.get(relPath);
      if (!count) return;
      fileFailures.delete(relPath);
      totals.failed -= count;
      const dir = path.posix.dirname(relPath);
      issuesByDirectory.get(dir === '.' ? '' : dir).failed -= count;
      forParents(dir, key => { if (reports.has(key)) reports.get(key).failed -= count; });
      samples.failed = samples.failed.filter(row => row.relPath !== relPath);
    };
    const unavailable = item => {
      if (!unreadable.size) return false;
      let result = false;
      forParents(path.posix.dirname(item.relPath), key => { if (unreadable.has(key)) result = true; });
      return result;
    };
    const changeVisibleCount = (item, difference) => {
      this.stats[item.type === 'photo' ? 'photoCount' : 'videoCount'] += difference;
      this.stats.total += difference;
    };

    this.log('info', 'Scanning ' + this._label(folder) + ' with up to ' + this.workers + ' workers.');
    this._persist({ startedAt, reportPaths: [...reportPaths] });
    try {
      const rootIds = new Map();
      const verifyRoots = async initial => {
        await bounded(roots, this.readers, async root => {
          if (this.stopping || unreadable.has(root)) return;
          try {
            const id = await this._work('mount identity', root, () => this._rootIdentity(root));
            const before = rootIds.get(root);
            if (!initial && (before.device !== id.device || before.inode !== id.inode))
              throw Error('The directory was replaced or its storage remounted during the scan. Reconnect the original mount and rescan.');
            rootIds.set(root, id);
          } catch (error) {
            if (error.code === STORAGE_UNRESPONSIVE) throw error;
            rootIds.delete(root);
            if (!this.stopping) issue('walkErrors', root, summarizeError(error, this.cfg.mediaDir), 'mount identity');
          }
        });
      };
      await verifyRoots(true);
      await this._walkMedia(roots.filter(root => rootIds.has(root)), { found, reports, issue });
      if (this.stopping) return { interrupted: true };
      this.log('info', 'Discovered ' + progress.discovered.toLocaleString() + ' media files in ' + progress.directories.toLocaleString() + ' directories.');

      this._phase('checking');
      await verifyRoots(false);
      if (this.stopping) return { interrupted: true };

      const cfgFingerprint = processingConfigFingerprint(this.cfg);
      const recipesByType = {
        photo: processingRecipes(this.cfg, 'photo'),
        video: processingRecipes(this.cfg, 'video'),
      };
      const byRel = new Map();
      for (const item of this.db.items.values()) if (matches(item.relPath)) byRel.set(item.relPath, item);
      const presentPaths = new Set(found.map(file => file.relPath));
      const absentByHash = new Map();
      for (const item of byRel.values()) {
        if (!item.sourceHash || item.availability === 'archived' || presentPaths.has(item.relPath) || unavailable(item)) continue;
        const candidates = absentByHash.get(item.sourceHash) || [];
        candidates.push(item);
        absentByHash.set(item.sourceHash, candidates);
      }
      const renamed = new Set();
      const newSizes = new Map();
      if (absentByHash.size) {
        const candidates = found.filter(file => !byRel.has(file.relPath) && !unavailable(file));
        await bounded(candidates, this.statWorkers, async file => {
          if (this.stopping) return;
          try {
            const stat = await this._work('checking move candidate', file.relPath, () => this._filesystem(() => fsp.lstat(file.full)));
            if (stat.isFile()) {
              file.moveSize = stat.size;
              newSizes.set(stat.size, (newSizes.get(stat.size) || 0) + 1);
            }
          } catch (error) {
            if (error.code === STORAGE_UNRESPONSIVE) throw error;
            // Import checks this path again at admission and records any read error there.
          }
        });
      }
      const perform = async (job, stage) => {
        if (this.stopping || job.failed || repairPaths.has(job.f.relPath) || !job.stages.includes(stage)) return;
        try {
          await this._processOne(job, stage);
          if (stage === job.stages[0]) {
            if (job.isNew) added++;
            else updated++;
            if (job.isNew || job.wasArchived) changeVisibleCount(job.f, 1);
          }
          this.onChange();
        } catch (error) {
          job.failed = true;
          if (error.code === STORAGE_UNRESPONSIVE) throw error;
          if (repairPaths.has(job.f.relPath)) return;
          if (this.stopping) return;
          issue('failed', job.f.relPath, summarizeError(error, this.cfg.mediaDir), stage);
        }
      };

      this._phase('processing');
      this.log('info', 'Checking files and processing posters, previews and optional recognition.');
      const prepare = async f => {
        if (this.scanPause) await this._waitForScan();
        if (this.stopping || repairPaths.has(f.relPath) || unavailable(f)) return;
        const existing = byRel.get(f.relPath);
        try {
          const readStat = () => this._filesystem(() => fsp.lstat(f.full));
          const stat = await this._work('file information', f.relPath, readStat);
          if (!stat.isFile()) throw Error('Path is no longer a regular file');
          let sourceHash;
          if (!force && canReuseHash(existing, stat)) sourceHash = existing.sourceHash;
          else {
            sourceHash = await this._hashSource(f, stat);
            assertSameSource(stat, await this._work('verifying source hash', f.relPath, readStat));
          }
          const missing = !force && existing?.sourceVersion === sourceHash ? await this._work('checking cached derivatives', f.relPath,
            () => this._filesystem(() => missingRepresentations(this.cfg, existing))) : { basic: false, preview: false };
          f.plan = { stat, sourceHash, missing };
        } catch (error) {
          if (error.code === STORAGE_UNRESPONSIVE) throw error;
          if (this.stopping || repairPaths.has(f.relPath)) return;
          issue('failed', f.relPath, summarizeError(error, this.cfg.mediaDir));
        } finally { progress.examined++; }
      };
      const queueJob = async f => {
        if (this.scanPause) await this._waitForScan();
        if (!f.plan || this.stopping || repairPaths.has(f.relPath)) return;
        const { stat, sourceHash } = f.plan;
        let { missing } = f.plan;
        delete f.plan;
        const fingerprint = `${stat.mtimeMs}:${stat.size}:${cfgFingerprint}`;
        const recipes = recipesByType[f.type];
        let existing = byRel.get(f.relPath);
        if (!existing && this.db.relocate && f.moveSize === stat.size && newSizes.get(stat.size) === 1) {
          const candidates = (absentByHash.get(sourceHash) || []).filter(item => !renamed.has(item.id) && !repairPaths.has(item.relPath));
          if (candidates.length === 1) {
            existing = this.db.relocate(candidates[0], f.relPath);
            renamed.add(existing.id);
            missing = { basic: true, preview: true };
          }
        }
        const makeAvailable = () => {
          if (existing.availability === 'available' && existing.fingerprint === fingerprint &&
              (!existing.scanFileIdentity || existing.scanFileIdentity === fileIdentity(stat))) return;
          this.db.upsert({ ...existing, fingerprint, scanFileIdentity: fileIdentity(stat), availability: 'available' });
          if (existing.availability === 'archived') changeVisibleCount(existing, 1);
          this.onChange();
        };
        if (!force && existing?.sourceVersion === sourceHash && existing.fingerprint === fingerprint && existing.processing?.stage === 'ready' &&
            !missing.basic && !missing.preview) {
          makeAvailable();
          return;
        }
        const id = existing ? existing.id : this._reserveId(f.relPath);
        let stages = ['basic', 'preview', 'analysis'];
        if (!force && existing?.sourceVersion === sourceHash && existing.derivativeRecipes) {
          stages = stages.filter(stage => existing.derivativeRecipes[stage] !== recipes[stage] || existing.processing?.failedStage === stage || missing[stage]);
          if (!stages.length) {
            if (existing.processing?.stage === 'ready') {
              makeAvailable();
              return;
            }
            stages = [existing.processing?.stage || 'basic'];
          }
        }
        const job = { f, stat, fingerprint, recipes, stages, sourceHash, sourceVersion: sourceHash,
          id, isNew: !existing, wasArchived: existing?.availability === 'archived' };
        this.admittedIds.set(f.relPath, id);
        try {
          for (const stage of stages) {
            if (this.stopping || job.failed || repairPaths.has(f.relPath)) break;
            await this.queue.push(() => perform(job, stage));
          }
        } finally {
          if (!this.repairs.has(f.relPath)) this.admittedIds.delete(f.relPath);
        }
      };
      const reads = new Queue(this.readers);
      const active = new PendingWork();
      const pipelineLimit = Math.max(8, this.workers * 3, this.readers * 2);
      for (const file of importOrder(found, folder === null ? this.mediaFolders : null)) {
        if (this.scanPause) await this._waitForScan();
        if (this.stopping || active.error) break;
        active.add(reads.push(() => prepare(file))
          .then(() => queueJob(file))
          .catch(error => {
            if (error.code === STORAGE_UNRESPONSIVE) throw error;
            if (!this.stopping) issue('failed', file.relPath, summarizeError(error, this.cfg.mediaDir));
          })
          .finally(() => {
            progress.processed++;
            progress.lastProgressAt = new Date().toISOString();
          }));
        if (active.count >= pipelineLimit) {
          await active.next();
          // A warm scan may be almost entirely cache hits. Yield to HTTP between admission rounds.
          if (progress.processed % 256 === 0) await new Promise(setImmediate);
        }
      }
      await active.drain();
      if (this.scanPause) await this._waitForScan();
      if (this.stopping) return { interrupted: true };

      this._phase('reconciling');
      this.log('info', 'Processing finished. Checking for moved, missing and archived entries.');
      await verifyRoots(false);
      if (folder === null && roots.length === rootIds.size) scope = rootScope([...rootIds.values()]);
      for (const item of byRel.values()) {
        if (this.scanPause) await this._waitForScan();
        if (this.stopping) return { interrupted: true };
        if (renamed.has(item.id) || repairPaths.has(item.relPath) || item.availability === 'archived') continue;
        const offline = unavailable(item);
        if (offline || !presentPaths.has(item.relPath)) {
          let availability = offline ? 'offline' : 'missing';
          if (!offline && item.type === 'video') {
            try {
              const archived = await this._work('checking archived source', item.relPath,
                () => hasArchivedOriginal(this.cfg.mediaDir, item, action => this._filesystem(action)));
              if (archived) availability = 'archived';
            } catch (error) {
              if (this.stopping) return { interrupted: true };
              if (error.code === STORAGE_UNRESPONSIVE) throw error;
              issue('failed', item.relPath, summarizeError(error, this.cfg.mediaDir));
              availability = 'offline';
            }
          }
          if (!repairPaths.has(item.relPath) && item.availability !== availability) {
            this.db.upsert({ ...item, availability });
            if (availability === 'archived') {
              changeVisibleCount(item, -1);
              removed++;
            }
          }
        }
        progress.reconciled++;
        if (progress.reconciled % 256 === 0) {
          progress.lastProgressAt = new Date().toISOString();
          await new Promise(setImmediate);
        }
      }
      for (const key of this.issuesByDirectory.keys()) {
        if (matchesIssue(key)) this.issuesByDirectory.delete(key);
      }
      for (const [key, counts] of issuesByDirectory) this.issuesByDirectory.set(key, counts);
      this._updateIssueCounts();
      for (const kind of Object.keys(samples))
        this[kind] = [...samples[kind], ...this[kind].filter(row => !matchesIssue(row.relPath))]
          .slice(0, ERROR_SAMPLES);
      status = totals.walkErrors || totals.failed ? (progress.directories ? 'partial' : 'failed') : 'success';
      if (added || updated || removed) this.onChange();
      return { added, updated, removed, total: this.db.count() };
    } catch (error) {
      status = 'failed';
      this.warn(error.code === STORAGE_UNRESPONSIVE ? STORAGE_UNRESPONSIVE : 'SCAN_FAILED',
        'Scan failed: ' + summarizeError(error, this.cfg.mediaDir), folder, progress.phase, 'error');
      throw error;
    } finally {
      clearInterval(progressLog);
      const at = new Date().toISOString();
      const elapsed = Date.now() - started;
      const lastScan = {
        at, startedAt, status, durationMs: elapsed, folder, added, updated, removed,
        photos: this.stats.photoCount, videos: this.stats.videoCount,
        unsupported: totals.unsupported, failed: totals.failed, unreadableDirectories: totals.walkErrors,
        scope: status === 'success' || status === 'partial' && !totals.walkErrors ? scope : null,
      };
      for (const [key, counts] of reports) {
        const parentUnavailable = unavailable({ relPath: key ? key + '/.' : '.' });
        let outcome = status;
        if (status === 'success' || status === 'partial') {
          if (parentUnavailable || !counts.directories) outcome = 'failed';
          else outcome = counts.failed || counts.unreadableDirectories ? 'partial' : 'success';
        }
        this.reports.set(key, { ...counts, at, startedAt, durationMs: elapsed, status: outcome,
          ...(outcome === 'interrupted' ? { previous: this.previousReport(key) } : {}) });
      }
      this.lastScan = lastScan;
      if (folder === null && lastScan.scope) this.lastFullScan = lastScan;
      this.history = [...this.history, lastScan].slice(-30);
      this.log(status === 'success' ? 'info' : 'warn',
        'Scan of ' + this._label(folder) + ' ' + status + ' after ' + Math.round(elapsed / 1000) + ' s. ' +
        progress.processed.toLocaleString() + ' media checked; ' + added.toLocaleString() + ' added, ' +
        totals.failed.toLocaleString() + ' failed, ' + totals.walkErrors.toLocaleString() + ' unreadable directories.');
      this._persist(null);
      this.scanning = false;
      this.scanRepairPaths = null;
      this.resolveCurrentFailure = null;
      if (!this.repairs.size) this.reservedSlugs = null;
      this.progress = null;
      this._releaseScanPause();
      this._resolveScan?.(); this._resolveScan = null;
      if (!this.stopping && this.pending.size) {
        const [key, next] = this.pending.entries().next().value;
        this.pending.delete(key);
        this.startScan(next);
      }
    }
  }

  waitForIdle() { return Promise.allSettled([this._scanSettled, ...this.repairs.values()]); }

  _reserveId(relative) {
    this.reservedSlugs ??= new Set(this.db.reservedIds ? this.db.reservedIds() : this.db.items.keys());
    return slugFor(relative, this.reservedSlugs);
  }

  canRepair(relPath) {
    return typeof relPath === 'string' && !!relPath && !relPath.includes('\0') && !path.posix.isAbsolute(relPath) &&
      !relPath.includes('\\') && !relPath.split('/').some(segment => !segment || segment.startsWith('.')) &&
      this.db.includesMediaPath(relPath) && !!classify(path.extname(relPath)) &&
      this.db.findByRelPath(relPath)?.availability !== 'archived';
  }

  repair(relPath) {
    if (this.repairs.has(relPath)) return this.repairs.get(relPath);
    if (this.stopping || this.editing) throw Error('The library is stopping or being edited.');
    if (!this.canRepair(relPath)) throw Error('This path cannot be repaired in VidStream.');
    this.scanRepairPaths?.add(relPath);
    const task = this.repairQueue.push(async () => {
      // An admitted stage may be publishing several files. Let just that writer finish.
      await this.writingStage.get(relPath)?.catch(() => {});
      if (this.stopping) throw Error('Library processing stopped.');
      this.repairingPath = relPath;
      try { return await this._repairFile(relPath); }
      finally { this.repairingPath = null; }
    }).finally(() => {
      this.repairs.delete(relPath);
      this.admittedIds.delete(relPath);
      if (!this.scanning && !this.repairs.size) this.reservedSlugs = null;
    });
    this.repairs.set(relPath, task);
    return task;
  }

  async _repairFile(relPath) {
    const ext = path.extname(relPath);
    const type = classify(ext);
    const existing = this.db.findByRelPath(relPath);
    const id = existing?.id || this.admittedIds.get(relPath) || this._reserveId(relPath);
    this.log('info', 'Repair started for ' + relPath);
    try {
      const full = await this._filesystem(() => resolveMediaSource(this.cfg.mediaDir, relPath));
      const stat = await this._filesystem(() => fsp.lstat(full));
      if (!stat.isFile()) throw Error('The source is no longer a regular file.');
      const f = { full, relPath, ext, type };
      const sourceHash = await this._hashSource(f, stat, true);
      assertSameSource(stat, await this._filesystem(() => fsp.lstat(full)));
      const fingerprint = `${stat.mtimeMs}:${stat.size}:${processingConfigFingerprint(this.cfg)}`;
      await this._processOne({ f, stat, sourceHash, sourceVersion: sourceHash, fingerprint, id, foreground: true });
      const directory = path.posix.dirname(relPath);
      const key = directory === '.' ? '' : directory;
      if (this.failed.some(row => row.relPath === relPath)) {
        this.failed = this.failed.filter(row => row.relPath !== relPath);
        const counts = this.issuesByDirectory.get(key);
        if (counts?.failed) counts.failed--;
        this._updateIssueCounts();
      }
      this.resolveCurrentFailure?.(relPath);
      this.log('info', 'Rebuilt VidStream media for ' + relPath);
    } catch (error) {
      const reason = summarizeError(error, this.cfg.mediaDir);
      this.log('warn', 'Repair could not rebuild ' + relPath + ': ' + reason);
      throw Error(reason);
    } finally {
      if (!existing && this.db.get(id)) {
        this.stats[type === 'photo' ? 'photoCount' : 'videoCount']++;
        this.stats.total++;
      }
      if (!this.scanning) this._persist(null);
    }
  }

  async _rootIdentity(relative) {
    const root = relative ? path.join(this.cfg.mediaDir, relative) : this.cfg.mediaDir;
    const stat = await this._filesystem(() => fsp.stat(root, { bigint: true }));
    if (!stat.isDirectory()) throw Error('Mount root is not a directory');
    return { root, device: stat.dev.toString(), inode: stat.ino.toString(),
      created: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : null };
  }

  async scanScope(savedScope) {
    const roots = this.mediaFolders || [''];
    try {
      const sources = await Promise.all(roots.map(root => this._rootIdentity(root)));
      const scope = rootScope(sources);
      if (!savedScope || savedScope === scope) return scope;
      if (savedScope.startsWith(ROOT_SCOPE_PREFIX)) return null;
      const legacy = crypto.createHash('sha256').update(JSON.stringify([
        sources.map(({ root, device, inode }) => [root, device, inode]), processingConfigFingerprint(this.cfg)
      ])).digest('hex');
      return savedScope === legacy ? scope : null;
    } catch { return null; }
  }

  async hasSavedScan() {
    const saved = this.lastFullScan;
    if (!saved?.scope || (this.db.count() === 0 && (saved.photos || saved.videos))) return false;
    const scope = await this.scanScope(saved.scope);
    if (!scope) return false;
    if (scope !== saved.scope && this.lastFullScan === saved) {
      this.lastFullScan = { ...saved, scope };
      if (!this.scanning) this._persist(null);
    }
    return true;
  }

  async _processOne(job, onlyStage = null) {
    const { f, stat, fingerprint, sourceHash, sourceVersion, recipes, id } = job;
    const relDir = path.dirname(f.relPath);
    const album = relDir === '.' ? null : relDir;
    const existing = this.db.get(id, { includeArchived: true });
    const sourceChanged = existing?.sourceVersion !== sourceVersion;
    if (existing && (existing.size !== stat.size || existing.mtime !== stat.mtime.toISOString())) {
      this.db.store.record(existing, 'file-changed', { previousSize:existing.size, size:stat.size, previousModified:existing.mtime, modified:stat.mtime.toISOString() });
    }
    const baseline = {
      ...existing,
      id,
      type: f.type,
      relPath: f.relPath,
      album,
      creator: album ? album.split('/')[0] : '(Unsorted)',
      filename: path.basename(f.relPath),
      ext: f.ext,
      mtime: stat.mtime.toISOString(),
      birthtime: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null,
      size: stat.size, scanFileIdentity: fileIdentity(stat),
      sourceHash, sourceVersion, derivativeRecipe: processingConfigFingerprint(this.cfg), availability: 'available',
      fingerprint,
      guest: existing ? existing.guest === true : false,
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    };
    const execute = (stage, action) => {
      const work = () => this._work(stage === 'basic' ? 'poster and metadata' : stage, f.relPath, task => {
        if (job.foreground) return action(task);
        if (this.scanRepairPaths?.has(f.relPath))
          throw Object.assign(Error('A manual repair owns this file.'), { code: 'REPAIR_SUPERSEDED_SCAN' });
        const writing = action(task);
        this.writingStage.set(f.relPath, writing);
        return writing.finally(() => this.writingStage.delete(f.relPath));
      }, job.foreground);
      return this.coordinator && !job.foreground
        ? this.coordinator.run(stage === 'basic' ? 'poster' : stage, f.relPath, work,
          { priority: stage === 'basic' ? 10 : stage === 'preview' ? 20 : 40, identity: id + ':' + stage,
            persistent: false, canStart: () => !this.scanPause })
        : work();
    };
    let record = baseline;
    for (const stage of onlyStage ? [onlyStage] : ['basic', 'preview', 'analysis']) {
      if (this.stopping) throw Error('Library processing stopped.');
      try {
        record = await execute(stage, async task => {
          const staging = path.join(this.cfg.cacheDir, '.staging', crypto.randomUUID());
          const cleanup = () => stage === 'analysis' ? undefined : fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
          let preparing;
          let preparationFinished = false;
          const progress = command => {
            if (command) task.command = command;
            task.lastProgressAt = new Date().toISOString();
            if (this.progress && !job.foreground) this.progress.lastProgressAt = task.lastProgressAt;
          };
          try {
            const result = await this.guard.run(this.stageTimeout, task, progress, (signal, touch) => {
              preparing = scanCommands.run({ signal, progress: touch }, async () => {
                touch(stage === 'analysis' ? 'Opening prepared media' : 'Preparing temporary cache');
                const paths = await derivativePaths(this.cfg, staging, id, f.type, stage);
                signal.throwIfAborted();
                const value = f.type === 'photo'
                  ? await processPhoto(f.full, f.ext, paths, this.cfg, { stage, previous: record })
                  : await processVideo(f.full, paths, this.cfg, { stage, previous: record });
                signal.throwIfAborted();
                if (stage === 'basic') value.metadata = await require('./metadata').readMetadata(f.full);
                signal.throwIfAborted();
                touch('Verifying source');
                assertSameSource(stat, await fsp.lstat(f.full));
                return value;
              }).finally(() => { preparationFinished = true; });
              return preparing;
            });
            if (stage !== 'analysis') {
              progress('Saving generated files');
              await promoteDerivatives(staging, this.cfg.cacheDir, this.cfg.derivativeCache);
            }
            const nextStage = job.stages ? job.stages[job.stages.indexOf(stage) + 1] : stage === 'analysis' ? null : stage === 'basic' ? 'preview' : 'analysis';
            const processing = { stage: nextStage || 'ready',
              previewReady: stage !== 'basic' || (!sourceChanged && existing?.processing?.previewReady === true),
              analysisReady: stage === 'analysis' || (!sourceChanged && existing?.processing?.analysisReady === true) };
            const next = { ...record, ...result, processing,
              ...(job.foreground && stage === 'analysis' ? { repairedAt: new Date().toISOString() } : {}),
              derivativeRecipes: { ...record.derivativeRecipes, [stage]: recipes?.[stage] || processingRecipes(this.cfg, f.type)[stage] } };
            progress('Saving catalog entry');
            this.db.upsert(next); this.onChange(); return this.db.get(id);
          } finally {
            if (!preparing || preparationFinished) {
              if (stage !== 'analysis' && preparing) progress('Cleaning temporary cache');
              await cleanup();
            } else preparing.then(cleanup, cleanup);
          }
        });
      } catch (err) {
        if (this.stopping || err.code === STORAGE_UNRESPONSIVE || (!job.foreground && this.scanRepairPaths?.has(f.relPath))) throw err;
        const visible = this.db.get(id);
        if (visible) this.db.upsert({ ...visible, processing: { ...visible.processing,
          stage: 'failed', failedStage: stage, error: summarizeError(err, this.cfg.mediaDir) } });
        throw err;
      }
    }
  }

  startWatching() {
    if (this.stopping || !this.cfg.watchForChanges || this._watchLoopStarted || this.mediaFolders?.length === 0) return;
    this._watchLoopStarted = true;
    this._openWatcher();
    this._restartTimer = setInterval(() => {
      this._closeWatcherOnly();
      this._openWatcher();
    }, 6 * 60 * 60 * 1000);
  }

  _openWatcher() {
    if (this.stopping || !this.cfg.watchForChanges) return;
    const root = this.cfg.mediaDir;
    const directories = this.mediaFolders === null ? [root] : this.mediaFolders.map((name) => path.join(root, name));
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        if (this.mediaFolders !== null && !fs.lstatSync(directory).isDirectory()) continue;
        const watcher = fs.watch(directory, { recursive: true }, (_event, relative) => {
          if (this.watchers.get(directory) !== watcher) return;
          if (typeof relative === 'string' && relative.split(path.sep).some(segment => segment === ARCHIVE_DIRECTORY || segment === PORTABLE_STORAGE_DIRECTORY)) return;
          clearTimeout(this._watchDebounceTimer);
          this._watchDebounceTimer = setTimeout(() => {
            this.scan().catch((err) => this.warn('SCAN_WATCH_TRIGGER_FAILED', `Watch-triggered scan failed: ${err.message}`));
          }, 2000);
        });
        this.watchers.set(directory, watcher);
        watcher.on('error', (err) => {
          this.warn('SCAN_WATCH_ERROR', `File watcher error (${err.message}); reopening.`, path.relative(root, directory));
          this._closeWatcher(directory);
          this._openWatcher();
        });
        this.log('info', 'Watching media folder for changes.');
      } catch (err) {
        this.warn('SCAN_WATCH_UNAVAILABLE',
          `File watching unavailable on this filesystem (${err.message}); use the Rescan button to pick up new files.`,
          path.relative(root, directory)
        );
      }
    }
  }

  _closeWatcher(directory) {
    const watcher = this.watchers.get(directory);
    if (!watcher) return;
    watcher.removeAllListeners();
    watcher.close();
    this.watchers.delete(directory);
  }

  _closeWatcherOnly() {
    for (const directory of this.watchers.keys()) this._closeWatcher(directory);
  }

  stopFileWatching() {
    clearInterval(this._restartTimer);
    clearTimeout(this._watchDebounceTimer);
    this._watchLoopStarted = false;
    this._closeWatcherOnly();
  }

  stopWatching() {
    this.stopping = true;
    this._releaseScanPause();
    this.storage.abort();
    this.pending.clear();
    this.stopFileWatching();
  }
}

module.exports = { Scanner, scannerWorkerCount, classify, PHOTO_EXTS, VIDEO_EXTS };
