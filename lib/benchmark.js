'use strict';
const { filesystemCapacity } = require('./filesystem-capacity');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pbkdf2, randomBytes, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { isAdmin } = require('./auth');
const { resourceLimits } = require('./hardware-limits');
const { overlaps, physicalPath } = require('./cache-runtime');
const { sendJson } = require('./handlers/api');

const MiB = 1024 * 1024;
const CACHE_SAMPLE = 16 * MiB;
const NETWORK_SAMPLE = 4 * MiB;
const ITERATIONS = 100_000;
const TMPFS_MAGIC = 0x01021994;
const MAX_NETWORK_TRANSFERS = 2;
const MAX_FOLDERS = 64;
const makeBytes = promisify(randomBytes);
const runPbkdf2 = promisify(pbkdf2);

function capacity(stat) {
  return { freeBytes: Number(stat.freeBytes), totalBytes: Number(stat.totalBytes) };
}

function asMiBps(bytes, elapsedMs) {
  return bytes / MiB / (Math.max(0.01, elapsedMs) / 1000);
}

async function measureCache(cacheDir) {
  const file = path.join(cacheDir, '.benchmark-' + randomUUID());
  const data = await makeBytes(CACHE_SAMPLE);
  const handle = await fs.open(file, 'wx+', 0o600);
  let unlinked = false;
  try {
    if (process.platform !== 'win32') {
      await fs.unlink(file);
      unlinked = true;
    }
    const started = performance.now();
    await handle.writeFile(data);
    await handle.sync();
    const writeMiBps = asMiBps(data.length, performance.now() - started);
    const readStarted = performance.now();
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('Benchmark sample ended early');
      offset += bytesRead;
    }
    return { sampleBytes: data.length, writeMiBps, warmReadMiBps: asMiBps(offset, performance.now() - readStarted) };
  } finally {
    try { await handle.close(); }
    finally { if (!unlinked) await fs.unlink(file); }
  }
}

async function cacheSample(cfg, warnings) {
  const result = { freeBytes: null, totalBytes: null, sampleBytes: 0, writeMiBps: null,
    warmReadMiBps: null, storage: 'unknown', boundedBytes: cfg.cacheMaxBytes || null };
  let cacheDir;
  try {
    cacheDir = await physicalPath(cfg.cacheDir);
    const backing = cfg.cacheSnapshotDir ? path.dirname(cfg.cacheSnapshotDir) : cacheDir;
    const storage = await filesystemCapacity(cacheDir);
    const runtime = capacity(storage);
    const ram = Boolean(cfg.cacheSnapshotDir) || storage.type === BigInt(TMPFS_MAGIC);
    Object.assign(result, backing === cacheDir ? runtime : capacity(await filesystemCapacity(backing)), {
      storage: ram ? 'ram' : 'disk',
      runtimeFreeBytes: runtime.freeBytes,
      runtimeTotalBytes: runtime.totalBytes,
      boundedBytes: ram ? null : result.boundedBytes,
    });
    if (runtime.freeBytes < (ram ? 64 : 512) * MiB) warnings.push('Cache speed skipped to preserve free space on the cache filesystem.');
    else if (overlaps(await physicalPath(cfg.mediaDir), cacheDir)) warnings.push('Cache speed skipped because the cache is inside the media library.');
    else Object.assign(result, await measureCache(cacheDir));
  } catch {
    warnings.push('The cache filesystem speed or capacity could not be measured. Check that the cache is accessible and writable.');
  }
  return result;
}

async function cpuSample(warnings) {
  const started = performance.now();
  try {
    await runPbkdf2('VidStream benchmark', 'synthetic CPU sample', ITERATIONS, 32, 'sha256');
    return { elapsedMs: performance.now() - started, iterations: ITERATIONS };
  } catch {
    warnings.push('The CPU sample could not be measured.');
    return null;
  }
}

async function previewSample(cfg, db) {
  const directory = path.join(cfg.cacheDir, 'preview');
  const result = { durationSeconds: cfg.videoPreviewDuration, maxWidth: cfg.videoPreviewMaxWidth,
    sampleCount: 0, sampleMeanBytes: null, sampleUpperBytes: null, sampleUpperBitsPerSecond: null };
  try {
    if (!(await fs.lstat(directory)).isDirectory()) return result;
    const entries = [];
    const handle = await fs.opendir(directory);
    try {
      for (let index = 0; index < 48 && entries.length < 16; index++) {
        const entry = await handle.read();
        if (!entry) break;
        if (entry.isFile() && entry.name.endsWith('.mp4')) entries.push(entry.name);
      }
    } finally { await handle.close(); }
    const samples = (await Promise.all(entries.map(async name => {
      try {
        const stat = await fs.lstat(path.join(directory, name));
        if (stat.isFile() && stat.size > 0) {
          const duration = db.get(name.slice(0, -4))?.duration;
          return { bytes: stat.size, seconds: duration > 0 ? Math.min(duration, result.durationSeconds) : null };
        }
      } catch {}
      return null;
    }))).filter(Boolean);
    if (samples.length) {
      const bitrates = samples.filter(sample => sample.seconds > 0).map(sample => 8 * sample.bytes / sample.seconds);
      result.sampleCount = samples.length;
      result.sampleMeanBytes = Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0) / samples.length);
      result.sampleUpperBytes = Math.max(...samples.map(sample => sample.bytes));
      if (bitrates.length) result.sampleUpperBitsPerSecond = Math.round(Math.max(...bitrates));
    }
  } catch {}
  return result;
}

async function librarySample(db) {
  const top = new Map((db.mediaFolders || []).slice(0, MAX_FOLDERS).map(folder => [folder, 0]));
  let indexedCount = 0;
  let elsewhere = 0;
  for (const item of db.visibleItems()) {
    const slash = item.relPath.indexOf('/');
    const name = slash > 0 ? item.relPath.slice(0, slash) : 'Library root';
    if (top.has(name) || top.size < MAX_FOLDERS) top.set(name, (top.get(name) || 0) + 1);
    else elsewhere++;
    if (++indexedCount % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  const folders = [...top].map(([name, count]) => ({ name, count }));
  if (elsewhere) folders.push({ name: 'Other folders', count: elsewhere });
  return { folders, indexedCount };
}

function benchmarkHandlers(cfg, db, scanner) {
  let activeHostRun = false;
  let transfers = 0;
  let fixture;
  function authorize(req, res) {
    if (isAdmin(req, cfg) && req.headers['sec-fetch-site'] !== 'cross-site') return true;
    sendJson(res, 403, { error: 'Owner sign-in required.' });
    return false;
  }

  return {
    async host(req, res) {
      if (!authorize(req, res)) return;
      if (activeHostRun) return sendJson(res, 409, { error: 'A host benchmark is already running.' });
      activeHostRun = true;
      try {
        const warnings = [];
        if (scanner.scanning) warnings.push('A library scan is running. Repeat the benchmark when the host is idle to compare results.');
        const host = { ...resourceLimits(), platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model || null };
        const cpu = await cpuSample(warnings);
        const cache = await cacheSample(cfg, warnings);
        const preview = await previewSample(cfg, db);
        const library = await librarySample(db);
        const result = { schemaVersion: 1, measuredAt: new Date().toISOString(), host, cpu, cache, preview, library, warnings };
        if (!res.destroyed) sendJson(res, 200, result);
      } finally { activeHostRun = false; }
    },

    async network(req, res) {
      if (!authorize(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const headers = { 'Cache-Control': 'private, no-store, no-transform' };
      if (url.searchParams.get('probe') === '1') {
        res.writeHead(204, headers);
        return res.end();
      }
      if (transfers >= MAX_NETWORK_TRANSFERS) return sendJson(res, 429, { error: 'The network benchmark is busy.' });
      transfers++;
      const timeout = setTimeout(() => res.destroy(), 30_000).unref();
      res.once('close', () => {
        clearTimeout(timeout);
        transfers--;
      });
      fixture ??= makeBytes(NETWORK_SAMPLE).catch(error => { fixture = undefined; throw error; });
      const buffer = await fixture;
      if (res.destroyed) return;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length });
      res.end(buffer);
    },
  };
}

module.exports = { benchmarkHandlers };
