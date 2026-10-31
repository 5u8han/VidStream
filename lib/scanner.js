'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('node:crypto');
const { digest, commitFile } = require('./durable-files');
const { slugFor } = require('./slug');
const { Queue } = require('./queue');
const { processPhoto } = require('./media-photo');
const { processVideo } = require('./media-video');

// HEIC/HEIF (the default on iPhones since iOS 11) and TIFF/BMP are
// real formats people's libraries actually contain -- missing HEIC
// specifically means an iPhone-sourced photo library silently
// vanishes while .mov videos from the same phone work fine. ImageMagick
// reads all of these as long as its build includes the relevant
// delegate libraries (libheif for HEIC) -- if it can't, that file
// surfaces in the "failed" list below rather than just disappearing.
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.tif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.nomedia']);

function classify(ext) {
  const e = ext.toLowerCase();
  if (PHOTO_EXTS.has(e)) return 'photo';
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}

// out.found: recognized media files. out.unsupported: everything else
// with a real extension, so nothing silently vanishes from view.
async function walk(dir, baseDir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Missing/unavailable SMB mounts are NOT evidence that media was deleted.
    out.walkErrors.push({ relPath: path.relative(baseDir, dir).split(path.sep).join('/'), error: summarizeError(err, baseDir) });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, baseDir, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const relPath = path.relative(baseDir, full).split(path.sep).join('/');
      if (!ext || IGNORED_FILES.has(entry.name.toLowerCase())) continue;
      const type = classify(ext);
      if (!type) {
        out.unsupported.push({ relPath, ext });
        continue;
      }
      out.found.push({ full, relPath, ext, type });
    }
  }
}

function derivativePaths(cacheDir, id) {
  const dirFor = (kind, width) => path.join(cacheDir, kind, String(width));
  const sized = (kind) => (width, ext) => {
    fs.mkdirSync(dirFor(kind, width), { recursive: true });
    return path.join(dirFor(kind, width), id + ext);
  };
  const flat = (kind) => (ext) => {
    fs.mkdirSync(path.join(cacheDir, kind), { recursive: true });
    return path.join(cacheDir, kind, id + ext);
  };
  return {
    thumb: sized('thumb'),
    large: sized('large'),
    poster: sized('poster'),
    preview: flat('preview'),
  };
}

async function promoteDerivatives(staging, cacheDir) {
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
        await commitFile(source, dest);
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
          try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
      }
    }
  }
  const previewDir = path.join(cacheDir, 'preview');
  try {
    for (const f of fs.readdirSync(previewDir)) {
      if (f.startsWith(id + '.')) {
        try { fs.unlinkSync(path.join(previewDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* no preview dir yet */ }
}

// Config that affects derivative *output* -- folded into each file's
// fingerprint so changing these in .env triggers reprocessing.
function processingConfigFingerprint(cfg) {
  return JSON.stringify([
    "metadata-preview-v2", cfg.thumbnailSizes, cfg.largeSizes, cfg.posterSizes,
    cfg.videoPreviewDuration, cfg.videoPreviewMaxWidth, cfg.videoPreviewFps,
    cfg.enableFaceDetection, cfg.enablePetDetection,
    cfg.enableOcr, cfg.enableDuplicateDetection, cfg.enableObjectDetection, cfg.objectModelPath, cfg.objectDevice,
  ]);
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
  const previewFiles = item.type === 'photo'
    ? cfg.largeSizes.map(width => path.join(cfg.cacheDir, 'large', String(width), item.id + (item.largeExt || '.jpg')))
    : [path.join(cfg.cacheDir, 'preview', item.id + '.mp4')];
  const [basic, preview] = await Promise.all([Promise.all(basicFiles.map(exists)), Promise.all(previewFiles.map(exists))]);
  return { basic: basic.some(value => !value), preview: preview.some(value => !value) };
}

// Reduce a tool failure to the one line a person can act on (e.g.
// "insufficient image data in file") instead of a whole command line.
function summarizeError(err, mediaDir) {
  const raw = (err && err.stderr ? String(err.stderr) : '') || (err && err.message) || 'unknown error';
  let line = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || raw;
  line = line.replace(/^[\w.-]+:\s*/, '').replace(/\s*@\s*error\/\S+/, '');
  if (mediaDir) line = line.split(mediaDir + '/').join('');
  return line.slice(0, 200);
}

class Scanner {
  constructor(cfg, db, { onLog = () => {}, onChange = () => {}, coordinator = null } = {}) {
    this.cfg = cfg;
    this.db = db;
    this.onLog = onLog;
    this.onChange = onChange;
    this.coordinator = coordinator;
    this.queue = new Queue(cfg.processingConcurrency);
    this.scanning = false;
    this.stopping = false;
    this.watcher = null;
    // Recomputed fresh every scan, not merged incrementally -- so a
    // file that gets fixed/removed drops out of these on the next scan.
    const cached = Array.from(db.items.values());
    this.stats = {
      photoCount: cached.filter((i) => i.type === 'photo').length,
      videoCount: cached.filter((i) => i.type === 'video').length,
      unsupportedCount: 0, failedCount: 0, unreadableDirectoryCount: 0, total: cached.length,
    };
    this.unsupported = [];
    this.failed = [];
    this.historyFile = path.join(cfg.cacheDir, 'scan-history.json');
    try { this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')).slice(-30); }
    catch { this.history = []; }
    this.lastScan = this.history.length ? this.history[this.history.length - 1] : null;
    this.walkErrors = [];
  }

  async scan({ force = false } = {}) {
    if (this.stopping || this.scanning || this.editing) return { skipped: true };
    this.scanning = true;
    this._scanSettled = new Promise(resolve => { this._resolveScan = resolve; });
    const started = Date.now();
    let added = 0;
    let updated = 0;
    let removed = 0;

    try {
      const found = [];
      const unsupported = [];
      const walkErrors = [];
      await walk(this.cfg.mediaDir, this.cfg.mediaDir, { found, unsupported, walkErrors });
      this.walkErrors = walkErrors;
      this.unsupported = unsupported;

      const seenRelPaths = new Set();
      const existingSlugs = new Set(
        this.db.reservedIds ? this.db.reservedIds() : Array.from(this.db.items.values(), (i) => i.id)
      );
      const cfgFingerprint = processingConfigFingerprint(this.cfg);

      // Stat in parallel batches: on a network share (SMB/NFS) every stat is
      // a round trip, so doing them one at a time makes big libraries crawl.
      const stats = new Array(found.length);
      const statErrors = [];
      for (let i = 0; i < found.length; i += 32) {
        await Promise.all(
          found.slice(i, i + 32).map(async (f, j) => {
            try { stats[i + j] = await fsp.stat(f.full); }
            catch (err) {
              stats[i + j] = null;
              statErrors.push({ relPath: f.relPath, error: summarizeError(err, this.cfg.mediaDir) });
            }
          })
        );
      }
      const byRel = new Map();
      for (const item of this.db.items.values()) byRel.set(item.relPath, item);
      const presentPaths = new Set(found.map(file => file.relPath));
      const unavailable = item => walkErrors.some(e => !e.relPath || e.relPath === '.' || item.relPath.startsWith(e.relPath + '/'));
      const absent = [...this.db.items.values()].filter(item => !presentPaths.has(item.relPath) && !unavailable(item));
      const renamed = new Set();

      const jobs = [];
      const failed = [...statErrors], failedIds = new Set(), basicPromises = [];
      const newSizes = new Map();
      found.forEach((file, i) => { if (!byRel.has(file.relPath) && stats[i]) newSizes.set(stats[i].size, (newSizes.get(stats[i].size) || 0) + 1); });
      const perform = async (job, stage) => {
        if (failedIds.has(job.id) || !job.stages.includes(stage)) return;
        try {
          await this._processOne(job, stage);
          if (stage === job.stages[0]) { if (job.isNew) added++; else updated++; }
          this.onChange();
        } catch (err) {
          failedIds.add(job.id);
          const reason = summarizeError(err, this.cfg.mediaDir);
          this.onLog(`Failed to process ${job.f.relPath}: ${reason}`);
          failed.push({ relPath: job.f.relPath, error: reason });
        }
      };
      for (let idx = 0; idx < found.length; idx++) {
        const f = found[idx];
        seenRelPaths.add(f.relPath);
        const stat = stats[idx];
        if (!stat) continue;
        const fingerprint = `${stat.mtimeMs}:${stat.size}:${cfgFingerprint}`;
        const recipes = processingRecipes(this.cfg, f.type);
        let existing = byRel.get(f.relPath);
        // A forced reconciliation must inspect bytes too: restored/copied
        // media can change while deliberately preserving size and timestamps.
        let sourceHash = !force && existing?.sourceHash && existing.size === stat.size && existing.mtime === stat.mtime.toISOString() ? existing.sourceHash : null;
        if (!sourceHash) {
          try { sourceHash = this.coordinator
            ? await this.coordinator.run('metadata', f.relPath + ' · content identity', () => digest(f.full), { priority: 15 })
            : await digest(f.full); }
          catch (err) { failed.push({ relPath: f.relPath, error: summarizeError(err, this.cfg.mediaDir) }); continue; }
        }
        // Be conservative when several new files have an identical byte size:
        // leave them distinct rather than guessing which is a moved original.
        if (!existing && this.db.relocate && newSizes.get(stat.size) === 1) {
          const candidates = absent.filter(item => item.sourceHash === sourceHash && !renamed.has(item.id));
          if (candidates.length === 1) {
            existing = this.db.relocate(candidates[0], f.relPath); renamed.add(existing.id); byRel.set(f.relPath, existing);
          }
        }

        const missing = existing ? await missingRepresentations(this.cfg, existing) : { basic: true, preview: true };
        if (!force && existing && existing.fingerprint === fingerprint && existing.processing?.stage === 'ready' && !missing.basic && !missing.preview) {
          if (existing.availability !== 'available') this.db.upsert({ ...existing, availability: 'available' });
          continue;
        }

        if (existing) existingSlugs.delete(existing.id);
        const id = existing ? existing.id : slugFor(f.relPath, existingSlugs);

        let stages = ['basic', 'preview', 'analysis'];
        if (!force && existing?.sourceVersion === sourceHash && existing.derivativeRecipes) {
          stages = stages.filter(stage => existing.derivativeRecipes[stage] !== recipes[stage] || existing.processing?.failedStage === stage || missing[stage]);
          if (!stages.length) {
            if (existing.processing?.stage === 'ready') { this.db.upsert({ ...existing, fingerprint, availability: 'available' }); continue; }
            stages = [existing.processing?.stage || 'basic'];
          }
        }
        const job = { f, stat, fingerprint, recipes, stages, sourceHash, sourceVersion: sourceHash, id, isNew: !existing };
        jobs.push(job);
        // Start posters while later files are still being identified, instead
        // of making first useful media wait for hashing the entire library.
        basicPromises.push(this.queue.push(() => perform(job, 'basic')));
      }

      await Promise.all(basicPromises);
      // All basic records/posters are published before background previews and
      // analysis begin, so a large import is useful while enrichment continues.
      for (const stage of ['preview', 'analysis']) await Promise.all(
        jobs.map((job) =>
          this.queue.push(() => perform(job, stage))
        )
      );
      this.failed = failed;

      for (const item of Array.from(this.db.items.values())) {
        // An unreadable subtree must not be interpreted as deleted files.
        const inFailedDirectory = walkErrors.some((e) => !e.relPath || e.relPath === '.' ||
          item.relPath.startsWith(e.relPath + '/'));
        if (inFailedDirectory || !seenRelPaths.has(item.relPath)) {
          const availability = inFailedDirectory ? 'offline' : 'missing';
          if (item.availability !== availability) this.db.upsert({ ...item, availability });
        }
      }

      const photoCount = Array.from(this.db.items.values()).filter((i) => i.type === 'photo').length;
      const videoCount = Array.from(this.db.items.values()).filter((i) => i.type === 'video').length;
      this.stats = {
        photoCount,
        videoCount,
        unsupportedCount: this.unsupported.length,
        failedCount: this.failed.length,
        unreadableDirectoryCount: walkErrors.length,
        total: photoCount + videoCount + this.unsupported.length + this.failed.length,
      };

      const ms = Date.now() - started;
      this.lastScan = {
        at: new Date().toISOString(), durationMs: ms, added, updated, removed,
        photos: photoCount, videos: videoCount,
        unsupported: this.unsupported.length, failed: failed.length,
        unreadableDirectories: walkErrors.length,
      };
      this.history.push(this.lastScan);
      this.history = this.history.slice(-30);
      try {
        fs.mkdirSync(this.cfg.cacheDir, { recursive: true });
        fs.writeFileSync(this.historyFile + '.tmp', JSON.stringify(this.history));
        fs.renameSync(this.historyFile + '.tmp', this.historyFile);
      } catch (err) { this.onLog(`Could not save scan history: ${err.message}`); }
      this.onLog(
        `Scan complete in ${ms}ms: +${added} added, ${updated} updated, -${removed} removed ` +
        `(${photoCount} photos, ${videoCount} videos, ${this.unsupported.length} unsupported, ${this.failed.length} failed)`
      );
      if (added || updated || removed) this.onChange();
      return { added, updated, removed, total: this.db.count() };
    } finally {
      this.scanning = false;
      this._resolveScan?.(); this._resolveScan = null;
    }
  }

  waitForIdle() { return this._scanSettled || Promise.resolve(); }

  async _processOne(job, onlyStage = null) {
    const { f, stat, fingerprint, sourceHash, sourceVersion, recipes, id } = job;
    const relDir = path.dirname(f.relPath);
    const album = relDir === '.' ? null : relDir;
    const existing = this.db.get(id);
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
      size: stat.size,
      sourceHash, sourceVersion, derivativeRecipe: processingConfigFingerprint(this.cfg), availability: 'available',
      fingerprint,
      guest: existing ? existing.guest === true : false,
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    };
    const execute = (stage, action) => this.coordinator
      ? this.coordinator.run(stage === 'basic' ? 'poster' : stage, f.relPath, action,
        { priority: stage === 'basic' ? 10 : stage === 'preview' ? 20 : 40, identity: id + ':' + stage })
      : action();
    let record = baseline;
    for (const stage of onlyStage ? [onlyStage] : ['basic', 'preview', 'analysis']) {
      try {
        record = await execute(stage, async () => {
          const staging = path.join(this.cfg.cacheDir, '.staging', crypto.randomUUID());
          const stagedPaths = derivativePaths(staging, id);
          const paths = stage === 'analysis' ? derivativePaths(this.cfg.cacheDir, id) : stagedPaths;
          try {
            const result = f.type === 'photo'
              ? await processPhoto(f.full, f.ext, paths, this.cfg, { stage, previous: record })
              : await processVideo(f.full, paths, this.cfg, { stage, previous: record });
            const after = await fsp.stat(f.full);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('Source changed during processing; scan again after it is stable');
            if (stage !== 'analysis') await promoteDerivatives(staging, this.cfg.cacheDir);
            const nextStage = job.stages ? job.stages[job.stages.indexOf(stage) + 1] : stage === 'analysis' ? null : stage === 'basic' ? 'preview' : 'analysis';
            const processing = { stage: nextStage || 'ready',
              previewReady: stage !== 'basic' || (!sourceChanged && existing?.processing?.previewReady === true),
              analysisReady: stage === 'analysis' || (!sourceChanged && existing?.processing?.analysisReady === true) };
            const next = { ...record, ...result, processing,
              derivativeRecipes: { ...record.derivativeRecipes, [stage]: recipes?.[stage] || processingRecipes(this.cfg, f.type)[stage] } };
            if (stage === 'basic') next.metadata = await require('./metadata').readMetadata(f.full);
            this.db.upsert(next); this.onChange(); return this.db.get(id);
          } finally { await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
        });
      } catch (err) {
        // A failed enrichment never hides a usable poster/previous preview.
        const visible = this.db.get(id);
        if (visible) this.db.upsert({ ...visible, processing: { ...visible.processing,
          stage: 'failed', failedStage: stage, error: summarizeError(err, this.cfg.mediaDir) } });
        throw err;
      }
    }
  }

  // fs.watch's recursive mode on Linux is a comparatively young feature
  // with real-world reports of gradual memory growth over long uptimes.
  // Closing and recreating it periodically bounds any such leak; the
  // 'error' listener prevents a watch failure from crashing the process.
  startWatching() {
    if (this.stopping || !this.cfg.watchForChanges || this._watchLoopStarted) return;
    this._watchLoopStarted = true;
    this._openWatcher();
    this._restartTimer = setInterval(() => {
      this._closeWatcherOnly();
      this._openWatcher();
    }, 6 * 60 * 60 * 1000);
  }

  _openWatcher() {
    let debounceTimer = null;
    try {
      this.watcher = fs.watch(
        this.cfg.mediaDir,
        { recursive: true },
        () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.scan().catch((err) => this.onLog(`Watch-triggered scan failed: ${err.message}`));
          }, 2000);
        }
      );
      this.watcher.on('error', (err) => {
        this.onLog(`File watcher error (${err.message}); reopening.`);
        this._closeWatcherOnly();
        this._openWatcher();
      });
      this.onLog('Watching media folder for changes.');
    } catch (err) {
      this.onLog(
        `File watching unavailable on this filesystem (${err.message}); use the Rescan button or restart to pick up new files.`
      );
    }
  }

  _closeWatcherOnly() {
    if (this.watcher) {
      this.watcher.removeAllListeners();
      this.watcher.close();
      this.watcher = null;
    }
  }

  stopWatching() {
    this.stopping = true;
    clearInterval(this._restartTimer);
    this._watchLoopStarted = false;
    this._closeWatcherOnly();
  }
}

module.exports = { Scanner, classify, PHOTO_EXTS, VIDEO_EXTS };
