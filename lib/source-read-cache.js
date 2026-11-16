'use strict';
const { filesystemCapacity } = require('./filesystem-capacity');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { physicalPath, overlaps } = require('./cache-runtime');
const { commitFile } = require('./durable-files');
const { sourceVersion } = require('./catalog');

const BLOCK_BYTES = 1024 * 1024;
const MIN_REFILL_BYTES = 16 * 1024;
const MAX_WRITES = 16;
const RESERVE_BYTES = 1024n ** 3n;
const SOURCE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function readExactly(handle, length, offset) {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (!bytesRead) throw Error('File changed during playback');
    done += bytesRead;
  }
  return buffer;
}

class SourceReadCache {
  constructor(cfg, { log = () => {} } = {}) {
    this.cfg = cfg;
    const snapshot = cfg.cacheSnapshotDir;
    this.parent = path.resolve(snapshot && path.basename(snapshot) === '.ram-cache'
      ? path.dirname(snapshot) : snapshot || cfg.cacheDir);
    this.root = path.join(this.parent, 'viewed-source');
    this.log = log;
    this.writes = new Map();
    this.enabled = false;
  }

  async initialize() {
    try {
      const parent = await physicalPath(this.parent);
      const candidate = path.join(parent, 'viewed-source');
      const protectedPaths = await Promise.all(
        [this.cfg.mediaDir, this.cfg.dataDir, this.cfg.originalsDir].filter(Boolean).map(physicalPath)
      );
      if (protectedPaths.some(directory => overlaps(candidate, directory) || overlaps(directory, candidate)))
        throw Error('cache directory overlaps library storage');
      await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
      if (await fs.realpath(candidate) !== candidate || !(await fs.lstat(candidate)).isDirectory())
        throw Error('cache directory must be a physical directory');
      this.root = candidate;
      this.enabled = true;
    } catch (error) {
      this.log('Viewed-media cache unavailable: ' + (error.code || error.message));
    }
  }

  reader(item) {
    if (!this.enabled || !sourceVersion(item)) return undefined;
    return (handle, stat, bounds) => {
      if (stat.size !== item.size || stat.mtime.toISOString() !== item.mtime)
        return handle.createReadStream(bounds);
      const version = identity(stat);
      const key = crypto.createHash('sha256').update(JSON.stringify([
        item.mediaId || item.id, sourceVersion(item), version
      ])).digest('hex');
      const directory = path.join(this.root, key.slice(0, 2), key);
      return Readable.from(this.blocks(handle, stat.size, version, bounds, directory), { objectMode: false });
    };
  }

  async *blocks(handle, size, version, bounds, directory) {
    let position = bounds?.start ?? 0;
    const end = (bounds?.end ?? size - 1) + 1;
    const refill = end - position >= MIN_REFILL_BYTES || position === 0 && end === size;
    for (; position < end;) {
      const offset = Math.floor(position / BLOCK_BYTES) * BLOCK_BYTES;
      const length = Math.min(BLOCK_BYTES, size - offset);
      const through = Math.min(end, offset + length);
      const file = path.join(directory, String(offset) + '.bin');
      const cached = this.writes.get(file)?.block || await this.read(file, length);
      if (cached) {
        yield cached.subarray(position - offset, through - offset);
      } else if (refill && this.writes.size < MAX_WRITES && await this.hasSpace()) {
        const block = await readExactly(handle, length, offset);
        if (identity(await handle.stat()) === version) this.remember(file, block);
        yield block.subarray(position - offset, through - offset);
      } else {
        yield await readExactly(handle, through - position, position);
      }
      position = through;
    }
  }

  async read(file, length) {
    let handle;
    try {
      const directory = path.dirname(file);
      if (await fs.realpath(directory) !== directory) return null;
      handle = await fs.open(file, SOURCE_READ_FLAGS);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== length) return null;
      return await readExactly(handle, length, 0);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async hasSpace() {
    const now = Date.now();
    if (this.space && now < this.space.until) return this.space.available;
    const available = filesystemCapacity(this.root)
      .then(info => info.freeBytes > RESERVE_BYTES + BigInt(MAX_WRITES * BLOCK_BYTES))
      .catch(() => false);
    this.space = { available, until: now + 1000 };
    return available;
  }

  remember(file, block) {
    if (!this.enabled || this.writes.has(file) || this.writes.size >= MAX_WRITES) return;
    const entry = { block };
    entry.done = this.write(file, block)
      .catch(() => { this.space = null; })
      .finally(() => this.writes.delete(file));
    this.writes.set(file, entry);
  }

  async write(file, block) {
    const directory = path.dirname(file);
    for (const part of [path.dirname(directory), directory]) {
      try { await fs.mkdir(part, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!(await fs.lstat(part)).isDirectory()) return;
    }
    if (await fs.realpath(directory) !== directory) return;
    const temp = path.join(directory, crypto.randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, block, { flag: 'wx', mode: 0o600 });
      await commitFile(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async stop() {
    this.enabled = false;
    await Promise.all([...this.writes.values()].map(entry => entry.done));
  }
}

module.exports = { SourceReadCache };
