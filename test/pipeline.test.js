'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Db } = require('../lib/db');
const { Scanner } = require('../lib/scanner');
const { WorkCoordinator } = require('../lib/work-coordinator');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-pipeline-'));
  const cfg = { mediaDir: path.join(dir, 'media'), cacheDir: path.join(dir, 'cache'),
    dataDir: path.join(dir, 'data'), processingConcurrency: 2, thumbnailSizes: [32], largeSizes: [64],
    posterSizes: [32], videoPreviewDuration: .3, videoPreviewMaxWidth: 64, videoPreviewFps: 60,
    enableFaceDetection: false, enablePetDetection: false, enableOcr: false, enableDuplicateDetection: false, enableObjectDetection: false };
  fs.mkdirSync(cfg.mediaDir);
  const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir);
  t.after(() => { clearTimeout(db._saveTimer); db.store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, cfg, db };
}
const hasConvert = spawnSync('convert', ['-version']).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('coordinator prioritizes visible work and never overlaps heavy tasks', async t => {
  const { db } = fixture(t), work = new WorkCoordinator(db.store);
  work.setPreset('process'); const started = []; let heavy = 0, peak = 0;
  const run = (name, options) => work.run(name, name, async () => {
    started.push(name); if (options.heavy) peak = Math.max(peak, ++heavy);
    await delay(15); if (options.heavy) heavy--; return name;
  }, options);
  await Promise.all([run('preview', { heavy: true }), run('analysis', { heavy: true }), run('poster', {})]);
  assert.equal(started[0], 'poster'); assert.equal(peak, 1);
  assert.equal(work.status().recent.filter(task => task.state === 'completed').length, 3);
});

test('nested work shares a permit, interrupted tasks remain visible, and stop settles queued work', async t => {
  const { db } = fixture(t), work = new WorkCoordinator(db.store); work.setPreset('browse');
  const nested = await work.run('edit', 'edit', () => work.run('poster', 'nested scan', async () => 7), { heavy: true });
  assert.equal(nested, 7);
  db.store.sql.prepare('INSERT INTO work_tasks VALUES(?,?)').run('interrupted', JSON.stringify({ id: 'interrupted', state: 'running' }));
  const restarted = new WorkCoordinator(db.store);
  assert.equal(restarted.status().recent.find(task => task.id === 'interrupted').state, 'interrupted');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const active = restarted.run('preview', 'active', () => gate, { heavy: true });
  await delay(0);
  const queued = restarted.run('metadata', 'queued', async () => {}); const rejected = assert.rejects(queued, /stopped/);
  restarted.stop(); await rejected; release(); await active;
});

test('browse mode permits one identity/poster task alongside a long preview, but bounds the extra work', async t => {
  const { db } = fixture(t), work = new WorkCoordinator(db.store); work.setPreset('browse');
  const started = [];
  let releasePreview, releasePoster;
  const previewGate = new Promise(resolve => { releasePreview = resolve; });
  const posterGate = new Promise(resolve => { releasePoster = resolve; });
  const encoding = work.run('preview', 'long preview', async () => {
    started.push('encoding'); await previewGate;
  }, { heavy: true });
  await delay(0);
  const analysis = work.run('analysis', 'object analysis', async () => { started.push('analysis'); }, { heavy: true });
  const metadata = work.run('metadata', 'background metadata', async () => { started.push('metadata'); });
  const firstPoster = work.run('poster', 'visible poster', async () => { started.push('poster 1'); await posterGate; });
  const secondPoster = work.run('poster', 'next visible poster', async () => { started.push('poster 2'); });
  await delay(0);
  assert.deepEqual(started, ['encoding', 'poster 1']);
  assert.equal(work.status().active.length, 2);
  assert.equal(work.status().active.filter(task => task.heavy).length, 1);
  assert.equal(work.status().queued.length, 3);
  releasePoster(); await firstPoster; await secondPoster;
  assert.deepEqual(started, ['encoding', 'poster 1', 'poster 2']);
  const identity = work.run('metadata', 'content identity', async () => { started.push('identity'); }, { priority: 15 });
  await identity;
  assert.deepEqual(started, ['encoding', 'poster 1', 'poster 2', 'identity']);
  releasePreview(); await Promise.all([encoding, metadata, analysis]);
  assert.ok(started.indexOf('metadata') < started.indexOf('analysis'));
  await work.stop();
});

test('staged imports publish posters first, keep source versions across recipes, preserve previews on refresh failure', { skip: !hasConvert }, async t => {
  const { cfg, db } = fixture(t), source = path.join(cfg.mediaDir, 'sample.jpg');
  execFileSync('convert', ['-size', '64x48', 'xc:red', source]);
  const states = [];
  const scanner = new Scanner(cfg, db, { coordinator: new WorkCoordinator(db.store), onChange() {
    const item = [...db.items.values()][0];
    if (item) states.push({ stage: item.processing.stage, thumb: fs.existsSync(path.join(cfg.cacheDir, 'thumb', '32', item.id + '.jpg')),
      large: fs.existsSync(path.join(cfg.cacheDir, 'large', '64', item.id + '.jpg')) });
  } });
  await scanner.scan(); const item = [...db.items.values()][0], version = item.sourceVersion;
  assert.ok(states.some(state => state.stage === 'preview' && state.thumb && !state.large));
  assert.equal(item.processing.stage, 'ready');
  const beforeTasks = scanner.coordinator.status().recent.length;
  cfg.videoPreviewMaxWidth = 128; await scanner.scan(); assert.equal(db.get(item.id).sourceVersion, version);
  assert.equal(scanner.coordinator.status().recent.length, beforeTasks, 'Video-only recipe changes must not process a photo');
  cfg.enableDuplicateDetection = true; await scanner.scan();
  const newTasks = scanner.coordinator.status().recent.slice(0, -beforeTasks);
  assert.equal(newTasks.length, 1); assert.equal(newTasks[0].kind, 'analysis');
  const thumb = path.join(cfg.cacheDir, 'thumb', '32', item.id + '.jpg'), previous = hash(thumb);
  fs.writeFileSync(source, 'invalid replacement'); await scanner.scan({ force: true });
  assert.equal(hash(thumb), previous); assert.equal(db.get(item.id).processing.stage, 'failed');
  assert.equal(scanner.failed.length, 1);
});

test('unambiguous source moves retain catalog identity while present copies remain separate', { skip: !hasConvert }, async t => {
  const { cfg, db } = fixture(t), original = path.join(cfg.mediaDir, 'one.jpg');
  execFileSync('convert', ['-size', '64x48', 'xc:blue', original]);
  const scanner = new Scanner(cfg, db); await scanner.scan();
  const old = [...db.items.values()][0]; db.store.update(old, { favorite: true });
  fs.renameSync(original, path.join(cfg.mediaDir, 'moved.jpg')); await scanner.scan();
  assert.equal(db.count(), 1); assert.equal(db.get(old.id).relPath, 'moved.jpg'); assert.equal(db.get(old.id).favorite, true);
  const identity = db.get(old.id).mediaId;
  fs.copyFileSync(path.join(cfg.mediaDir, 'moved.jpg'), path.join(cfg.mediaDir, 'copy.jpg')); await scanner.scan();
  assert.equal(db.count(), 2); assert.equal(db.get(old.id).mediaId, identity);
  assert.notEqual(db.findByRelPath('copy.jpg').mediaId, identity);
  fs.unlinkSync(path.join(cfg.mediaDir, 'moved.jpg')); await scanner.scan();
  assert.equal(db.get(old.id).availability, 'missing'); assert.equal(db.get(old.id).favorite, true);
});

test('durable catalog rebuilds a lost preview cache without changing identity or source version', { skip: !hasConvert }, async t => {
  const { cfg, db } = fixture(t), source = path.join(cfg.mediaDir, 'durable.jpg');
  execFileSync('convert', ['-size', '64x48', 'xc:green', source]);
  const scanner = new Scanner(cfg, db); await scanner.scan();
  const item = [...db.items.values()][0], identity = item.mediaId, version = item.sourceVersion;
  db.store.update(item, { favorite: true });
  const thumb = path.join(cfg.cacheDir, 'thumb', '32', item.id + '.jpg');
  fs.unlinkSync(thumb);
  await scanner.scan();
  assert.ok(fs.statSync(thumb).size > 0);
  assert.equal(db.get(item.id).mediaId, identity); assert.equal(db.get(item.id).sourceVersion, version);
  assert.equal(db.get(item.id).favorite, true);
  scanner.stopWatching(); assert.deepEqual(await scanner.scan(), { skipped: true });
});

test('forced reconciliation detects replacement bytes even when size and modification time are preserved', { skip: !hasConvert }, async t => {
  const { cfg, db } = fixture(t), source = path.join(cfg.mediaDir, 'replaced.bmp');
  const modified = new Date('2020-01-01T00:00:00.000Z');
  execFileSync('convert', ['-size', '64x48', 'xc:red', 'BMP3:' + source]);
  fs.utimesSync(source, modified, modified);
  const scanner = new Scanner(cfg, db); await scanner.scan();
  const before = { ...[...db.items.values()][0] };
  execFileSync('convert', ['-size', '64x48', 'xc:blue', 'BMP3:' + source]);
  fs.utimesSync(source, modified, modified);
  const stat = fs.statSync(source);
  assert.equal(stat.size, before.size); assert.equal(stat.mtime.toISOString(), before.mtime);
  await scanner.scan({ force: true });
  const after = db.get(before.id);
  assert.equal(after.mediaId, before.mediaId);
  assert.notEqual(after.sourceHash, before.sourceHash);
  assert.notEqual(after.sourceVersion, before.sourceVersion);
});

test('video metadata is available before preview encoding, then native frame rate is retained', { skip: !hasFfmpeg }, async t => {
  const { cfg, db } = fixture(t), source = path.join(cfg.mediaDir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=24', '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const states = [], scanner = new Scanner(cfg, db, { onChange() { const item = [...db.items.values()][0]; if (item) states.push({ ...item.processing }); } });
  await scanner.scan(); const item = [...db.items.values()][0];
  assert.ok(states.some(state => state.stage === 'preview' && state.previewReady === false));
  assert.equal(item.tech.frameRate, 24); assert.equal(item.tech.previewFrameRate, 24); assert.equal(item.processing.analysisReady, true);
});
