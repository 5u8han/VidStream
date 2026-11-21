'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { commitFile } = require('./durable-files');
const { processVideo, makeTimelineClip } = require('./media-video');
const { resolveMediaSource } = require('./serve-file');
const { sourceVersion } = require('./catalog');
const { physicalPath, overlaps } = require('./cache-runtime');
const { filesystemCapacity } = require('./filesystem-capacity');
const { Queue } = require('./queue');

const MIN_AGE = 30_000;
const MAX_RECENT = 65_536;
const MAX_REFILLS = 128;
const MAX_TIMELINE_REFILLS = 8;
const MiB = 1024 ** 2;

function matchingSource(stat, item) {
  return stat.isFile() && stat.size === item.size && stat.mtime.toISOString() === item.mtime;
}

class DerivativeCache {
  constructor(cfg, db, coordinator, { log = () => {} } = {}) {
    this.root = path.resolve(cfg.cacheDir);
    this.limit = cfg.cacheSnapshotDir ? 0 : (cfg.cacheMaxBytes || 0);
    const ram = cfg.cacheSnapshotDir;
    const desired = (cfg.videoTimelineCacheMiB || (ram ? 2048 : 8192)) * MiB;
    const ramShare = cfg.cacheRamBudgetBytes ? Math.floor(cfg.cacheRamBudgetBytes / 2) : Number.MAX_SAFE_INTEGER;
    this.timelineLimit = Math.min(this.limit || Number.MAX_SAFE_INTEGER, desired, ramShare);
    this.cfg = cfg;
    this.db = db;
    this.coordinator = coordinator;
    this.log = log;
    this.leases = new Map();
    this.recent = new Map();
    this.refills = new Map();
    this.timelineRefills = new Map();
    this.timelineQueue = new Queue(2);
    this.removing = new Map();
    this.stats = null;
    this.stopping = false;
  }

  async validate() {
    const protectedPaths = await Promise.all([this.cfg.mediaDir, this.cfg.dataDir, this.cfg.originalsDir]
      .filter(Boolean).map(physicalPath));
    for (const kind of ['preview-timeline', ...(this.limit ? ['preview', 'playback'] : [])]) {
      const target = await physicalPath(path.join(this.root, kind));
      if (!protectedPaths.some(directory => overlaps(target, directory) || overlaps(directory, target))) continue;
      if (kind === 'preview-timeline') {
        this.timelineLimit = 0;
        this.log('Timeline previews disabled because the cache overlaps protected library storage.');
      } else {
        this.log('Preview cache eviction disabled because its directory overlaps protected library storage.');
        this.cfg.cacheMaxBytes = this.limit = 0;
      }
    }
  }

  touch(file) {
    this.recent.delete(file);
    this.recent.set(file, Date.now());
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value);
  }

  async withLease(file, work, managed = this.limit) {
    if (!managed) return work();
    file = path.resolve(file);
    this.leases.set(file, (this.leases.get(file) || 0) + 1);
    this.touch(file);
    try {
      await this.removing.get(file);
      return await work();
    } finally {
      const count = this.leases.get(file);
      if (count === 1) this.leases.delete(file);
      else this.leases.set(file, count - 1);
      this.touch(file);
    }
  }

  start() {
    if ((!this.limit && !this.timelineLimit) || this.interval) return;
    this.interval = setInterval(() => this.sweep(), 60_000);
    this.interval.unref();
    this.sweep();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.interval);
    await this.sweeping;
  }

  sweep() {
    if ((!this.limit && !this.timelineLimit) || this.stopping) return;
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.prune()
      .catch(error => this.log('Preview cache cleanup failed: ' + error.message))
      .finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  async inventory(kind) {
    const directory = path.join(this.root, kind);
    let names;
    try {
      if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== path.join(await fs.realpath(this.root), kind))
        return [];
      names = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const ready = new Set(names);
    const candidates = new Map();
    const pattern = kind === 'preview' ? /^[\w.-]+\.mp4$/u
      : kind === 'playback' ? /^[a-f0-9]{64}\.(?:mp4|json)$/ : /^[a-f0-9]{64}\.mp4$/;
    for (const name of names) {
      if (!pattern.test(name)) continue;
      if (kind === 'playback' && name.endsWith('.json') && ready.has(name.slice(0, -5) + '.mp4')) continue;
      candidates.set(name, kind === 'playback' ? name.replace(/\.\w+$/, '') : null);
    }
    const results = [];
    const entries = [...candidates];
    const statFile = file => fs.lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    for (let at = 0; at < entries.length && !this.stopping; at += 32) {
      const batch = await Promise.all(entries.slice(at, at + 32).map(async ([name, compatibilityId]) => {
        const file = path.join(directory, name);
        const key = compatibilityId ? path.join(directory, compatibilityId + '.mp4') : file;
        const receipt = compatibilityId && file === key ? path.join(directory, compatibilityId + '.json') : null;
        const [stat, companion] = await Promise.all([statFile(file), receipt && statFile(receipt)]);
        if (!stat?.isFile()) return null;
        const files = [{ file, stat }];
        if (companion?.isFile()) files.push({ file: receipt, stat: companion });
        return { key, files, at: Math.max(stat.atimeMs, stat.mtimeMs),
          bytes: files.reduce((total, entry) => total + entry.stat.size, 0) };
      }));
      results.push(...batch.filter(Boolean));
    }
    return results;
  }

  async prune() {
    const timeline = this.timelineLimit ? await this.inventory('preview-timeline') : [];
    const { entries: remaining } = await this.pruneEntries(timeline, this.timelineLimit);
    if (!this.limit) return;
    const ordinary = (await Promise.all(['preview', 'playback'].map(kind => this.inventory(kind)))).flat();
    const retained = await this.pruneEntries(ordinary.concat(remaining), this.limit);
    this.stats = { bytes: retained.bytes, limitBytes: this.limit, checkedAt: new Date().toISOString() };
  }

  async pruneEntries(entries, limit) {
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let bytes = total;
    const removed = new Set();
    if (bytes > limit) {
      const cutoff = Date.now() - MIN_AGE;
      const lastUsed = entry => Math.max(entry.at, this.recent.get(entry.key) || 0);
      entries.sort((a, b) => lastUsed(a) - lastUsed(b));
      for (const entry of entries) {
        if (this.stopping || bytes <= limit * 0.9) break;
        if (lastUsed(entry) >= cutoff || this.leases.has(entry.key)) continue;
        const operation = this.remove(entry.files);
        this.removing.set(entry.key, operation);
        try {
          const freed = await operation;
          bytes -= freed;
          if (freed === entry.bytes) removed.add(entry);
          else if (freed) entry.bytes -= freed;
        } finally {
          this.removing.delete(entry.key);
        }
      }
    }
    if (removed.size) this.log('Preview cache removed ' + removed.size.toLocaleString() + ' old derivatives (' + (total - bytes).toLocaleString() + ' bytes).');
    return { bytes, entries: entries.filter(entry => !removed.has(entry)) };
  }

  async remove(files) {
    let removed = 0;
    for (const { file, stat } of files) {
      try {
        const current = await fs.lstat(file);
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino ||
            current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) continue;
        await fs.unlink(file);
        removed += stat.size;
      } catch (error) {
        if (error.code !== 'ENOENT') this.log('Preview cache could not remove a derivative: ' + error.code);
      }
    }
    return removed;
  }

  async ensurePreview(file, item) {
    if (!this.limit || this.stopping || item.processing?.previewReady === false ||
        ['offline', 'missing', 'archived'].includes(item.availability)) return;
    const existing = this.refills.get(file);
    if (existing) return existing;
    if (this.refills.size >= MAX_REFILLS) return;
    const restock = this.regenerateIfAbsent(file, item);
    this.refills.set(file, restock);
    try { await restock; }
    finally { this.refills.delete(file); }
  }

  timelineFile(item, minute) {
    if (!this.timelineLimit || !sourceVersion(item) || !Number.isSafeInteger(minute) || minute < 1 ||
        !Number.isFinite(item.duration) || minute * 60 >= item.duration) return null;
    const recipe = ['timeline-v1', item.id, sourceVersion(item), minute,
      this.cfg.videoPreviewMaxWidth, this.cfg.videoPreviewFps, item.tech?.frameRate];
    const key = crypto.createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
    return path.join(this.root, 'preview-timeline', key + '.mp4');
  }

  async ensureTimeline(file, item, minute) {
    const ready = await fs.lstat(file).then(stat => stat.isFile() && stat.size > 0, () => false);
    if (ready || this.stopping || ['offline', 'missing', 'archived'].includes(item.availability)) return;
    const existing = this.timelineRefills.get(file);
    if (existing) return existing;
    if (this.timelineRefills.size >= MAX_TIMELINE_REFILLS)
      throw Object.assign(Error('Timeline preview queue is full'), { status: 503 });
    const restock = this.timelineQueue.push(() => {
      if (this.stopping) return;
      return this.regenerateIfAbsent(file, item, async (source, temporary) => {
        const { freeBytes } = await filesystemCapacity(this.root);
        const reserve = BigInt(this.cfg.cacheSnapshotDir ? Math.min(128 * MiB, this.timelineLimit) : 1024 * MiB);
        if (freeBytes < reserve) throw Object.assign(Error('Timeline cache needs free space'), { status: 507 });
        return makeTimelineClip(source, temporary, item, minute, this.cfg);
      }, 'timeline:' + path.basename(file));
    });
    this.timelineRefills.set(file, restock);
    try { await restock; }
    finally { this.timelineRefills.delete(file); }
  }

  async regenerateIfAbsent(file, item, generate = (source, temporary) =>
    processVideo(source, { preview: () => temporary }, this.cfg, { stage: 'preview', previous: item }),
    identity = 'cache-preview:' + item.id) {
    const ready = () => fs.lstat(file).then(stat => stat.isFile() && stat.size > 0, () => false);
    if (await ready()) return;
    const run = async () => {
      if (await ready()) return;
      const source = await resolveMediaSource(this.cfg.mediaDir, item.relPath);
      const before = await fs.stat(source);
      if (!matchingSource(before, item)) return;
      const directory = path.join(this.root, '.staging');
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, crypto.randomUUID() + '.mp4');
      try {
        await generate(source, temporary);
        const after = await fs.stat(source);
        const current = this.db.get(item.id);
        if (!current || sourceVersion(current) !== sourceVersion(item) || !matchingSource(after, item) ||
            before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || !(await fs.stat(temporary)).size) return;
        if (await ready()) return;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await commitFile(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    };
    await this.coordinator.run('preview', item.relPath, run, { path: item.relPath, priority: 12, identity,
      persistent: !identity.startsWith('timeline:') });
  }
}

module.exports = { DerivativeCache };
