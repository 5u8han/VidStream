'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
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
    cfg.thumbnailSizes, cfg.largeSizes, cfg.posterSizes,
    cfg.videoPreviewDuration, cfg.videoPreviewMaxWidth, cfg.videoPreviewFps,
    cfg.enableFaceDetection, cfg.enablePetDetection,
    cfg.enableOcr, cfg.enableDuplicateDetection, cfg.enableObjectDetection, cfg.objectModelPath, cfg.objectDevice,
  ]);
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
  constructor(cfg, db, { onLog = () => {}, onChange = () => {} } = {}) {
    this.cfg = cfg;
    this.db = db;
    this.onLog = onLog;
    this.onChange = onChange;
    this.queue = new Queue(cfg.processingConcurrency);
    this.scanning = false;
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

  async scan() {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
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
        Array.from(this.db.items.values(), (i) => i.id)
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

      const jobs = [];
      for (let idx = 0; idx < found.length; idx++) {
        const f = found[idx];
        seenRelPaths.add(f.relPath);
        const stat = stats[idx];
        if (!stat) continue;
        const fingerprint = `${stat.mtimeMs}:${stat.size}:${cfgFingerprint}`;
        const existing = byRel.get(f.relPath);

        if (existing && existing.fingerprint === fingerprint) continue;

        if (existing) existingSlugs.delete(existing.id);
        const id = existing ? existing.id : slugFor(f.relPath, existingSlugs);

        jobs.push({ f, stat, fingerprint, id, isNew: !existing });
      }

      const failed = [...statErrors];
      await Promise.all(
        jobs.map((job) =>
          this.queue.push(async () => {
            try {
              await this._processOne(job);
              if (job.isNew) added++;
              else updated++;
              this.onChange();
            } catch (err) {
              const reason = summarizeError(err, this.cfg.mediaDir);
              this.onLog(`Failed to process ${job.f.relPath}: ${reason}`);
              failed.push({ relPath: job.f.relPath, error: reason });
            }
          })
        )
      );
      this.failed = failed;

      for (const item of Array.from(this.db.items.values())) {
        // An unreadable subtree must not be interpreted as deleted files.
        const inFailedDirectory = walkErrors.some((e) => !e.relPath || e.relPath === '.' ||
          item.relPath.startsWith(e.relPath + '/'));
        if (!inFailedDirectory && !seenRelPaths.has(item.relPath)) {
          removeDerivatives(this.cfg.cacheDir, item.id);
          this.db.remove(item.id);
          removed++;
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
    }
  }

  async _processOne(job) {
    const { f, stat, fingerprint, id } = job;
    removeDerivatives(this.cfg.cacheDir, id);
    const paths = derivativePaths(this.cfg.cacheDir, id);
    const relDir = path.dirname(f.relPath);
    const album = relDir === '.' ? null : relDir;

    const result =
      f.type === 'photo'
        ? await processPhoto(f.full, f.ext, paths, this.cfg)
        : await processVideo(f.full, paths, this.cfg);

    const existing = this.db.get(id);
    this.db.upsert({
      id,
      type: result.type,
      relPath: f.relPath,
      album,
      creator: album ? album.split('/')[0] : '(Unsorted)',
      filename: path.basename(f.relPath),
      ext: f.ext,
      width: result.width,
      height: result.height,
      dateTaken: result.dateTaken,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      color: result.color,
      isAnimated: result.isAnimated,
      duration: result.duration,
      hasAudio: result.hasAudio,
      thumbExt: result.thumbExt || '.jpg',
      largeExt: result.largeExt || '.jpg',
      faceCount: result.faceCount || 0,
      hasFace: result.hasFace === true,
      hasCat: result.hasCat === true,
      ocrText: result.ocrText || '',
      hasText: result.hasText === true,
      pHash: result.pHash || null,
      objects: Array.isArray(result.objects) ? result.objects : [],
      camera: result.camera || null,
      tech: result.tech || null,
      fingerprint,
      guest: existing ? existing.guest === true : false,
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    });
  }

  // fs.watch's recursive mode on Linux is a comparatively young feature
  // with real-world reports of gradual memory growth over long uptimes.
  // Closing and recreating it periodically bounds any such leak; the
  // 'error' listener prevents a watch failure from crashing the process.
  startWatching() {
    if (!this.cfg.watchForChanges || this._watchLoopStarted) return;
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
    clearInterval(this._restartTimer);
    this._watchLoopStarted = false;
    this._closeWatcherOnly();
  }
}

module.exports = { Scanner, classify, PHOTO_EXTS, VIDEO_EXTS };
