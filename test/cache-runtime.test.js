'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CacheRuntime } = require('../lib/cache-runtime');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstream-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cfg = { cacheDir: path.join(directory, 'ram'), cacheSnapshotDir: path.join(directory, 'volume', '.ram-cache'),
    dataDir: path.join(directory, 'data'), mediaDir: path.join(directory, 'media'), originalsDir: path.join(directory, 'originals') };
  const cache = new CacheRuntime(cfg);
  await cache.restore();
  return { directory, cfg, cache };
}
async function put(root, name, value) {
  const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
}

test('disk mode leaves existing cache unchanged and creates no snapshot', async t => {
  const { cfg } = await fixture(t);
  await put(cfg.cacheDir, 'thumb/320/test.jpg', 'existing preview');
  const disk = new CacheRuntime({ ...cfg, cacheSnapshotDir: '' });
  assert.deepEqual(await disk.restore(), { mode: 'disk', restored: 0 });
  assert.deepEqual(await disk.save(), { mode: 'disk', saved: 0 });
  assert.equal(await fs.readFile(path.join(cfg.cacheDir, 'thumb/320/test.jpg'), 'utf8'), 'existing preview');
});

test('RAM cache snapshots restore bytes, exclude incomplete work and preserve separate durable data', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', Buffer.from([0, 1, 2, 255]));
  await put(cfg.cacheDir, 'thumb/320/a.jpg', 'poster');
  for (const name of ['.staging/b/preview.mp4', 'preview/uncommitted.mp4.tmp', 'models/incomplete.download', 'session-secret', 'library-data/library.sqlite'])
    await put(cfg.cacheDir, name, 'must not snapshot');
  await put(cfg.dataDir, 'library.sqlite', 'durable catalog/history');
  const saved = await cache.save(); assert.equal(saved.saved, 2);
  await fs.rm(cfg.cacheDir, { recursive: true });
  assert.equal((await new CacheRuntime(cfg).restore()).restored, 2);
  assert.deepEqual(await fs.readFile(path.join(cfg.cacheDir, 'preview/a.mp4')), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(fs.access(path.join(cfg.cacheDir, 'session-secret')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(cfg.dataDir, 'library.sqlite'), 'utf8'), 'durable catalog/history');
});

test('first RAM run imports the existing cache volume without moving or deleting it', async t => {
  const { cfg } = await fixture(t);
  const legacy = path.dirname(cfg.cacheSnapshotDir);
  await put(legacy, 'preview/legacy.mp4', 'old disk preview');
  await put(legacy, 'library-data/library.sqlite', 'do not import database');
  const result = await new CacheRuntime(cfg).restore();
  assert.equal(result.legacy, true); assert.equal(result.restored, 1);
  assert.equal(await fs.readFile(path.join(cfg.cacheDir, 'preview/legacy.mp4'), 'utf8'), 'old disk preview');
  assert.equal(await fs.readFile(path.join(legacy, 'preview/legacy.mp4'), 'utf8'), 'old disk preview');
});

test('a failed snapshot keeps the previous committed snapshot usable', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'last good preview');
  await cache.save();
  const pointer = await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8');
  await fs.symlink(cfg.mediaDir, path.join(cfg.cacheDir, 'unsafe-link'));
  await assert.rejects(cache.save(), /symbolic links/);
  assert.equal(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'), pointer);
  await fs.rm(cfg.cacheDir, { recursive: true });
  await cache.restore();
  assert.equal(await fs.readFile(path.join(cfg.cacheDir, 'preview/a.mp4'), 'utf8'), 'last good preview');
});

test('corrupt snapshot is rejected and partial restore cannot masquerade as a complete cache', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'verified preview'); await cache.save();
  const pointer = JSON.parse(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'));
  const source = path.join(cfg.cacheSnapshotDir, pointer.generation, 'files/preview/a.mp4');
  await fs.writeFile(source, 'corrupt bytes');
  await fs.rm(cfg.cacheDir, { recursive: true });
  await assert.rejects(cache.restore(), /verification failed/);
  await fs.access(path.join(cfg.cacheDir, '.restore-incomplete'));
  await assert.rejects(cache.restore(), /verification failed/);
  const cold = new CacheRuntime({ ...cfg, cacheColdStart: true });
  assert.equal((await cold.restore()).cold, true);
  assert.equal((await cold.save()).saved, 0);
  assert.equal((await cache.restore()).restored, 0);
});

test('cold start skips both saved snapshots and legacy files without clearing persistent data', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'old preview'); await cache.save();
  const previous = await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8');
  await put(cfg.dataDir, 'security.json', 'owner credentials');
  assert.equal((await new CacheRuntime({ ...cfg, cacheColdStart: true }).restore()).cold, true);
  assert.deepEqual(await fs.readdir(cfg.cacheDir), []);
  assert.equal(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'), previous);
  assert.equal(await fs.readFile(path.join(cfg.dataDir, 'security.json'), 'utf8'), 'owner credentials');
});

test('RAM cache refuses overlapping or aliased media, database and snapshot paths', async t => {
  const { cfg } = await fixture(t);
  await fs.mkdir(cfg.dataDir); const alias = path.join(path.dirname(cfg.cacheDir), 'data-alias');
  await fs.symlink(cfg.dataDir, alias);
  for (const patch of [{ cacheDir: path.join(cfg.mediaDir, 'cache') }, { cacheDir: cfg.dataDir },
    { cacheSnapshotDir: path.join(cfg.dataDir, 'snapshot') }, { cacheDir: alias }])
    await assert.rejects(new CacheRuntime({ ...cfg, ...patch }).restore(), /must be separate/);
});

test('uncommitted generation is ignored and manifest traversal is rejected', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'committed preview'); await cache.save();
  await put(cfg.cacheSnapshotDir, '.generation-abandoned.pending/files/preview/a.mp4', 'partial preview');
  await fs.rm(cfg.cacheDir, { recursive: true }); await cache.restore();
  assert.equal(await fs.readFile(path.join(cfg.cacheDir, 'preview/a.mp4'), 'utf8'), 'committed preview');
  const pointer = JSON.parse(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'));
  const manifestPath = path.join(cfg.cacheSnapshotDir, pointer.generation, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../outside'; await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.rm(cfg.cacheDir, { recursive: true });
  await assert.rejects(cache.restore(), /invalid file entry/);
});

test('restore checks available capacity before copying a cache that cannot fit', async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'preview'); await cache.save();
  const pointer = JSON.parse(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'));
  const manifestPath = path.join(cfg.cacheSnapshotDir, pointer.generation, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const space = await fs.statfs(cfg.cacheDir);
  manifest.files[0].size = space.bavail * space.bsize + 2 * 1024 * 1024;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.rm(cfg.cacheDir, { recursive: true });
  await assert.rejects(cache.restore(), /does not fit/);
  assert.deepEqual(await fs.readdir(cfg.cacheDir), []);
  await fs.access(path.join(cfg.cacheSnapshotDir, 'current.json'));
});

test('killing a snapshot writer mid-copy leaves the last committed snapshot restorable', { timeout: 15000 }, async t => {
  const { cfg, cache } = await fixture(t);
  await put(cfg.cacheDir, 'preview/a.mp4', 'previous committed preview'); await cache.save();
  const pointer = await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8');
  await Promise.all(Array.from({ length: 128 }, (_, i) => put(cfg.cacheDir, 'thumb/320/' + i + '.jpg', Buffer.alloc(32768, i))));
  const code = "const { CacheRuntime } = require('./lib/cache-runtime'); new CacheRuntime(JSON.parse(process.argv[1])).save().catch(e => { console.error(e); process.exit(1); });";
  const child = spawn(process.execPath, ['-e', code, JSON.stringify(cfg)], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await fs.readdir(cfg.cacheSnapshotDir)).some(name => name.endsWith('.pending'))) break;
      assert.equal(child.exitCode, null, 'Snapshot finished before interruption test could observe it');
      await delay(1);
    }
    assert.ok((await fs.readdir(cfg.cacheSnapshotDir)).some(name => name.endsWith('.pending')));
    child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    assert.equal(await fs.readFile(path.join(cfg.cacheSnapshotDir, 'current.json'), 'utf8'), pointer);
    await fs.rm(cfg.cacheDir, { recursive: true }); await cache.restore();
    assert.equal(await fs.readFile(path.join(cfg.cacheDir, 'preview/a.mp4'), 'utf8'), 'previous committed preview');
    assert.deepEqual(await fs.readdir(cfg.cacheDir), ['preview']);
    assert.equal((await fs.readdir(cfg.cacheSnapshotDir)).some(name => name.endsWith('.pending')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
