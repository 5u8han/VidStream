'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { atomicJson, syncDir } = require('./durable-files');

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const GENERATION = new RegExp('^generation-' + UUID + '$');
const PENDING = new RegExp('^\\.generation-' + UUID + '\\.pending$');
const EXCLUDED = new Set(['.staging', '.ram-cache', '.restore-incomplete', 'library-data', 'session-secret']);

function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve existing ancestors too: an alias must not hide a media/data directory
// inside a directory that cold-start cleanup is allowed to empty.
async function physicalPath(file) {
  const suffix = [];
  let current = path.resolve(file);
  while (true) {
    try { return path.join(await fs.realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function inventory(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' && !prefix) return; throw error; }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name.endsWith('.tmp') || entry.name.endsWith('.download')) continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error('RAM cache cannot include symbolic links: ' + relative);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) {
        const stat = await fs.stat(path.join(directory, entry.name));
        files.push({ path: relative, size: stat.size });
      }
    }
  }
  await walk(root);
  return files;
}

async function copyVerified(source, destination, expected = null, durable = false) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.tmp';
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(createReadStream(source), new Transform({ transform(chunk, encoding, callback) {
      hash.update(chunk); size += chunk.length; callback(null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const digest = hash.digest('hex');
    if (expected && (expected.size !== size || expected.hash !== digest))
      throw Error('Cache snapshot verification failed: ' + expected.path);
    if (durable) {
      const handle = await fs.open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await fs.rename(temporary, destination);
    return { size, hash: digest };
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function sufficientSpace(directory, bytes) {
  const stat = await fs.statfs(directory, { bigint: true });
  // Leave a little room for the manifest/filesystem metadata. This check is
  // advisory; writes can still fail if another process consumes free space.
  const available = stat.bavail * stat.bsize;
  if (BigInt(bytes) + 1024n * 1024n > available)
    throw Error('Cache does not fit in the available storage (' + bytes + ' bytes required). Increase the RAM cache limit or start with CACHE_COLD_START=1.');
}

class CacheRuntime {
  constructor(cfg, { log = () => {} } = {}) {
    this.cfg = cfg;
    this.root = path.resolve(cfg.cacheDir);
    this.snapshot = cfg.cacheSnapshotDir ? path.resolve(cfg.cacheSnapshotDir) : null;
    this.log = log;
    this.enabled = Boolean(this.snapshot);
  }

  async validate() {
    const runtime = await physicalPath(this.root), snapshot = await physicalPath(this.snapshot);
    for (const [label, file] of [['snapshot', snapshot], ['media', this.cfg.mediaDir], ['database', this.cfg.dataDir], ['original archive', this.cfg.originalsDir]]) {
      if (!file) continue;
      const other = await physicalPath(file);
      if (overlaps(runtime, other) || overlaps(other, runtime))
        throw Error('RAM cache must be separate from the ' + label + ' directory');
      if (label !== 'snapshot' && (overlaps(snapshot, other) || overlaps(other, snapshot)))
        throw Error('Cache snapshot must be separate from the ' + label + ' directory');
    }
  }

  async pointer() {
    let pointer;
    try { pointer = JSON.parse(await fs.readFile(path.join(this.snapshot, 'current.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (pointer.version !== 1 || !GENERATION.test(pointer.generation || ''))
      throw Error('Cache snapshot pointer is invalid; preserve it for inspection or use CACHE_COLD_START=1');
    return pointer;
  }

  async cleanup(pointer) {
    for (const entry of await fs.readdir(this.snapshot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Only our exact generation names are eligible, and a valid current
      // pointer is always protected. Undefined means the pointer was damaged:
      // clean pending work only until a cold start commits a replacement.
      if (PENDING.test(entry.name) || (pointer !== undefined && GENERATION.test(entry.name) && entry.name !== pointer?.generation))
        await fs.rm(path.join(this.snapshot, entry.name), { recursive: true, force: true });
    }
  }

  async manifest(generation) {
    const manifest = JSON.parse(await fs.readFile(path.join(this.snapshot, generation, 'manifest.json'), 'utf8'));
    const seen = new Set();
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('Cache snapshot manifest is invalid');
    for (const file of manifest.files) {
      if (!relativeFile(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.hash || ''))
        throw Error('Cache snapshot contains an invalid file entry');
      seen.add(file.path);
    }
    return manifest;
  }

  async restore() {
    if (!this.enabled) return { mode: 'disk', restored: 0 };
    await this.validate();
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.snapshot, { recursive: true });
    const incomplete = path.join(this.root, '.restore-incomplete');
    const interrupted = await fs.access(incomplete).then(() => true, () => false);
    if (this.cfg.cacheColdStart || interrupted) {
      for (const entry of await fs.readdir(this.root)) await fs.rm(path.join(this.root, entry), { recursive: true, force: true });
    }
    if (this.cfg.cacheColdStart) {
      await this.cleanup(await this.pointer().catch(() => undefined));
      this.log('RAM cache: cold start requested; saved disk snapshot retained until the next clean shutdown.');
      return { mode: 'ram', restored: 0, cold: true };
    }
    const pointer = await this.pointer();
    await this.cleanup(pointer);
    // Docker tmpfs is empty on recreation. A native RAM disk can survive an
    // application restart; don't overwrite its newer files with an older copy.
    if ((await inventory(this.root)).length) {
      this.log('RAM cache: using existing runtime cache.');
      return { mode: 'ram', restored: 0, existing: true };
    }
    let source, files;
    if (pointer) {
      source = path.join(this.snapshot, pointer.generation, 'files');
      files = (await this.manifest(pointer.generation)).files;
    } else if (path.basename(this.snapshot) === '.ram-cache') {
      // The overlay mounts the former stream-cache volume at this parent.
      // Import it read-only on first opt-in; never move or delete old files.
      source = path.dirname(this.snapshot);
      files = await inventory(source);
    } else files = [];
    const bytes = files.reduce((total, file) => total + file.size, 0);
    await sufficientSpace(this.root, bytes);
    await fs.writeFile(incomplete, 'Restore is incomplete; retry before serving cache files.\n');
    try {
      for (const file of files) {
        await copyVerified(path.join(source, file.path), path.join(this.root, file.path), pointer ? file : null);
      }
      await fs.rm(incomplete);
    } catch (error) {
      // Leave the marker so a native RAM disk surviving process exit can retry
      // rather than accepting the partial restore as a complete runtime cache.
      throw error;
    }
    this.log('RAM cache: restored ' + files.length + ' files (' + bytes + ' bytes).');
    return { mode: 'ram', restored: files.length, bytes, legacy: !pointer };
  }

  async save() {
    if (!this.enabled) return { mode: 'disk', saved: 0 };
    await this.validate();
    await fs.mkdir(this.snapshot, { recursive: true });
    const previous = await this.pointer().catch(error => {
      // A deliberate cold start must also be able to replace a damaged pointer.
      if (this.cfg.cacheColdStart) return null;
      throw error;
    });
    await this.cleanup(previous);
    const files = await inventory(this.root), bytes = files.reduce((total, file) => total + file.size, 0);
    await sufficientSpace(this.snapshot, bytes);
    const generation = 'generation-' + crypto.randomUUID(), temporary = path.join(this.snapshot, '.' + generation + '.pending');
    await fs.mkdir(temporary, { recursive: false });
    try {
      const copied = [];
      for (const file of files) {
        const result = await copyVerified(path.join(this.root, file.path), path.join(temporary, 'files', file.path), null, true);
        if (result.size !== file.size) throw Error('Cache changed while taking snapshot; previous snapshot retained');
        copied.push({ path: file.path, ...result });
      }
      await atomicJson(path.join(temporary, 'manifest.json'), { version: 1, createdAt: new Date().toISOString(), bytes, files: copied });
      // Sync every directory, including nested preview size directories, before
      // publishing the pointer. A killed copy leaves the prior pointer intact.
      const directories = new Set([temporary]);
      for (const file of copied) {
        let directory = path.dirname(path.join(temporary, 'files', file.path));
        while (overlaps(temporary, directory)) {
          directories.add(directory);
          if (directory === temporary) break;
          directory = path.dirname(directory);
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDir(directory);
      await fs.rename(temporary, path.join(this.snapshot, generation));
      await syncDir(this.snapshot);
      await atomicJson(path.join(this.snapshot, 'current.json'), { version: 1, generation });
      if (previous?.generation && previous.generation !== generation)
        await fs.rm(path.join(this.snapshot, previous.generation), { recursive: true, force: true }).catch(() => {});
      this.log('RAM cache: saved ' + copied.length + ' files (' + bytes + ' bytes) to persistent storage.');
      return { mode: 'ram', saved: copied.length, bytes };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { CacheRuntime };
