'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { Db } = require('../lib/db');
const { Scanner } = require('../lib/scanner');
const { shortHash } = require('../lib/slug');
const { workbenchHandlers } = require('../lib/handlers/workbench');
const { findImageMagick } = require('../lib/exec');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-mounted-catalog-'));
  const cfg = {
    mediaDir: path.join(root, 'media'), cacheDir: path.join(root, 'cache'),
    dataDir: path.join(root, 'data'), processingConcurrency: 1,
    thumbnailSizes: [32], largeSizes: [64], posterSizes: [32],
    videoPreviewFps: 60, videoPreviewMaxWidth: 64, videoPreviewDuration: 1
  };
  fs.mkdirSync(cfg.mediaDir);
  const opened = new Set();
  function open(mediaFolders = null) {
    const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir, { mediaFolders });
    opened.add(db);
    return db;
  }
  function close(db) {
    db.store.close();
    opened.delete(db);
  }
  t.after(() => {
    for (const db of opened) db.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { cfg, open, close };
}

function put(db, id, relPath, extra = {}) {
  const album = path.posix.dirname(relPath);
  const item = {
    id, relPath, filename: path.posix.basename(relPath), album: album === '.' ? null : album,
    type: 'video', mtime: '2026-01-01', availability: 'available', ...extra
  };
  db.upsert(item);
  return item;
}

test('startup puts the designated mount ahead of alphabetically earlier folders', (t) => {
  const { cfg } = fixture(t);
  for (const name of ['Animations', 'Z First', 'doll']) fs.mkdirSync(path.join(cfg.mediaDir, name));
  const config = require.resolve('../lib/config');
  function foldersFor(primary) {
    const output = execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify(require(process.argv[1]).loadConfig(process.argv[2]).mediaFolders))',
      config, path.dirname(cfg.mediaDir)], {
      env: {
        MEDIA_DIR: cfg.mediaDir, MEDIA_FOLDER_MODE: 'mounted', MEDIA_PRIMARY_MOUNT: primary,
        SESSION_SECRET: 'primary-folder-test-secret',
      },
      encoding: 'utf8',
    });
    return JSON.parse(output);
  }
  assert.deepEqual(foldersFor(path.join(cfg.mediaDir, 'Z First')), ['Z First', 'Animations', 'doll']);
  assert.deepEqual(foldersFor(path.join(cfg.mediaDir, 'Unlisted')), ['Animations', 'doll', 'Z First']);
});

test('mount changes scope catalog and direct lookups while restoring prior IDs, preferences and history', (t) => {
  const { open, close } = fixture(t);
  const legacy = open();
  put(legacy, 'root-file', 'loose.mp4');
  put(legacy, 'similar', 'Public-old/loose.mp4');
  put(legacy, 'public', 'Public/2026/clip.mp4', { guest: true, objects: ['cat'] });
  put(legacy, 'literal', "Art %_'/Nested/clip.mp4", { guest: true, objects: ['car'] });
  const dormant = put(legacy, 'old-id', 'Private/clip.mp4', { guest: true, objects: ['person'] });
  legacy.store.update(dormant, { favorite: true });
  legacy.store.track(dormant, {
    id: crypto.randomUUID(), visitor: 'mount-test-viewer', at: new Date().toISOString(), action: 'open', details: {}
  });
  legacy.upsert({ ...dormant, id: 'new-id' });
  assert.equal(legacy.get('old-id').id, 'new-id');
  close(legacy);

  const mounted = open(['Public', "Art %_'"]);
  assert.deepEqual([...mounted.items.keys()].sort(), ['literal', 'public']);
  assert.equal(mounted.query({ guestOnly: true }).total, 2);
  assert.equal(mounted.query({ folderPath: "Art %_'/Nested" }).items[0].id, 'literal');
  assert.equal(mounted.query({ folderPath: 'Public-old' }).total, 0);
  assert.equal(mounted.query({ q: 'Private' }).total, 0);
  assert.deepEqual(mounted.filterOptions(true).objectClasses, ['car', 'cat']);
  const first = mounted.query({ limit: 1, sort: 'creator' });
  assert.equal(first.total, 2);
  assert.equal(mounted.query({ cursor: first.nextCursor, limit: 1, sort: 'creator' }).items[0].id, 'public');
  assert.equal(mounted.neighbors('public', { sort: 'creator' }).prev.id, 'literal');
  assert.equal(mounted.neighbors('new-id').index, -1);
  assert.equal(mounted.get('new-id'), null);
  assert.equal(mounted.get('old-id'), null);
  assert.equal(mounted.get(dormant.mediaId), null);
  assert.equal(mounted.findByRelPath('Private/clip.mp4'), null);
  assert.ok(mounted.reservedIds().includes('old-id'));
  assert.ok(mounted.reservedIds().includes('new-id'));
  assert.throws(() => put(mounted, 'old-id', 'Public/reused.mp4'), /reserved/);
  assert.throws(() => put(mounted, 'loose', 'loose.mp4'), /mounted folder/);
  mounted.remove('new-id');
  assert.equal(mounted.store.sql.prepare('SELECT count(*) AS count FROM catalog').get().count, 5);
  close(mounted);

  const empty = open([]);
  assert.equal(empty.count(), 0);
  assert.equal(empty.query().total, 0);
  assert.deepEqual(empty.filterOptions(), { albums: [], creators: [], objectClasses: [] });
  close(empty);

  const restored = open(['Private']);
  assert.equal(restored.get('old-id').id, 'new-id');
  assert.equal(restored.get(dormant.mediaId).favorite, true);
  assert.equal(restored.get(dormant.mediaId).activity.opens, 1);
  assert.equal(restored.query().total, 1);
});

test('mounted scan and watchers exclude loose files, other directories and symlink roots', async (t) => {
  const { cfg, open, close } = fixture(t);
  const legacy = open();
  put(legacy, 'unmounted', 'Missing/clip.mp4');
  put(legacy, 'other', 'Other/clip.mp4');
  put(legacy, 'replaced-link', 'Link/clip.mp4');
  close(legacy);

  for (const folder of ['Mounted', 'Other']) fs.mkdirSync(path.join(cfg.mediaDir, folder));
  fs.writeFileSync(path.join(cfg.mediaDir, 'Mounted', 'listed.pdf'), 'fixture');
  fs.writeFileSync(path.join(cfg.mediaDir, 'Other', 'ignored.mp4'), 'must not open');
  fs.writeFileSync(path.join(cfg.mediaDir, 'ignored.jpg'), 'must not open');
  fs.symlinkSync(path.join(cfg.mediaDir, 'Other'), path.join(cfg.mediaDir, 'Link'));

  const db = open(['Mounted', 'Missing', 'Link']);
  const scanner = new Scanner({ ...cfg, watchForChanges: true }, db);
  t.after(() => scanner.stopWatching());
  await scanner.scan();
  assert.deepEqual(scanner.unsupported.map((entry) => entry.relPath), ['Mounted/listed.pdf']);
  assert.deepEqual(scanner.failed, []);
  assert.deepEqual(scanner.walkErrors.map((entry) => entry.relPath).sort(), ['Link', 'Missing']);
  assert.equal(db.get('unmounted').availability, 'offline');
  assert.equal(db.get('replaced-link').availability, 'offline');

  const watched = [];
  t.mock.method(fs, 'watch', (directory) => {
    watched.push(directory);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    return watcher;
  });
  scanner.startWatching();
  assert.deepEqual(watched, [path.join(cfg.mediaDir, 'Mounted')]);
  scanner.stopWatching();
  close(db);
  assert.equal(open().get('other').availability, 'available');
});

const imageMagick = findImageMagick()?.command;
test('a new copy cannot take an unmounted item’s identity or an occupied hash slug', { skip: !imageMagick }, async (t) => {
  const { cfg, open, close } = fixture(t);
  fs.mkdirSync(path.join(cfg.mediaDir, 'Mounted'));
  const relative = 'Mounted/clip.jpg';
  const source = path.join(cfg.mediaDir, relative);
  execFileSync(imageMagick, ['-size', '64x48', 'xc:blue', source]);
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const hashed = 'clip-' + shortHash(relative);
  const legacy = open();
  const prior = put(legacy, 'clip', 'Dormant/clip.jpg', { type: 'photo', sourceHash, favorite: true });
  put(legacy, hashed, 'Dormant/another.jpg', { type: 'photo' });
  close(legacy);

  const mounted = open(['Mounted']);
  const scanner = new Scanner(cfg, mounted);
  await scanner.scan();
  assert.deepEqual(scanner.failed, []);
  const imported = mounted.findByRelPath(relative);
  assert.ok(imported);
  assert.notEqual(imported.mediaId, prior.mediaId);
  assert.notEqual(imported.id, 'clip');
  assert.notEqual(imported.id, hashed);
  assert.equal(imported.favorite, false);
  close(mounted);

  const restored = open(['Dormant']);
  assert.equal(restored.get('clip').mediaId, prior.mediaId);
  assert.equal(restored.get('clip').favorite, true);
  assert.equal(restored.get(hashed).relPath, 'Dormant/another.jpg');
});

test('manual relink accepts a selected directory and rejects loose, excluded and symlinked destinations', async (t) => {
  const { cfg, open } = fixture(t);
  for (const folder of ['Mounted', 'Other']) fs.mkdirSync(path.join(cfg.mediaDir, folder));
  const bytes = Buffer.from('identical test bytes');
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
  for (const file of ['loose.mp4', 'Other/new.mp4', 'Mounted/new.mp4']) {
    fs.writeFileSync(path.join(cfg.mediaDir, file), bytes);
  }
  fs.symlinkSync(path.join(cfg.mediaDir, 'Other', 'new.mp4'), path.join(cfg.mediaDir, 'Mounted', 'link.mp4'));
  const db = open(['Mounted']);
  const item = put(db, 'old', 'Mounted/old.mp4', { sourceHash });
  const identity = item.mediaId;
  const scanner = { scanning: false, editing: false };
  const handler = workbenchHandlers(cfg, db, { scanner }).relink;
  async function relink(relative) {
    const req = Readable.from([Buffer.from(JSON.stringify({ path: relative }))]);
    req.headers = { 'content-type': 'application/json' };
    const res = { writeHead(code) { this.code = code; }, end(body) { this.data = JSON.parse(body); } };
    await handler(req, res, { id: item.id });
    return res;
  }
  for (const destination of ['loose.mp4', 'Other/new.mp4', 'Mounted/link.mp4']) {
    const res = await relink(destination);
    assert.equal(res.code, 400);
    assert.match(res.data.error, /selected mounted folder/);
    assert.equal(item.relPath, 'Mounted/old.mp4');
  }
  assert.equal((await relink('Mounted/new.mp4')).code, 200);
  assert.equal(db.findByRelPath('Mounted/new.mp4').mediaId, identity);
  assert.equal(scanner.editing, false);
});
