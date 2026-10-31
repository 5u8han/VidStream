'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Db } = require('../lib/db');
const { libraryHandlers } = require('../lib/handlers/library');
const { workbenchHandlers } = require('../lib/handlers/workbench');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-identity-controls-'));
  const cfg = { mediaDir: path.join(root, 'media'), cacheDir: path.join(root, 'cache'), dataDir: path.join(root, 'data'), thumbnailSizes: [320], posterSizes: [320], largeSizes: [1280] };
  fs.mkdirSync(cfg.mediaDir);
  const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir);
  t.after(() => { db.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('known source bytes');
  const item = { id: 'old-link', relPath: 'old.mp4', filename: 'old.mp4', ext: '.mp4', type: 'video', creator: 'Folder artist', sourceHash: crypto.createHash('sha256').update(bytes).digest('hex') };
  db.upsert(item); db.store.update(item, { favorite: true });
  const scanner = { scanning: false, editing: false };
  return { root, cfg, db, bytes, item, scanner, handlers: workbenchHandlers(cfg, db, { scanner }) };
}
async function post(handler, id, data) {
  const req = Readable.from([Buffer.from(JSON.stringify(data))]);
  req.headers = { 'content-type': 'application/json' };
  const res = { writeHead(code) { this.code = code; }, end(value) { this.data = JSON.parse(value); } };
  await handler(req, res, { id });
  return res;
}

test('manual relink verifies bytes and preserves identity without overwriting another catalog item', async t => {
  const f = fixture(t), id = f.item.mediaId;
  fs.writeFileSync(path.join(f.cfg.mediaDir, 'moved.mp4'), f.bytes);
  let result = await post(f.handlers.relink, id, { path: 'moved.mp4' });
  assert.equal(result.code, 200, JSON.stringify(result.data));
  assert.equal(f.item.mediaId, id); assert.equal(f.item.relPath, 'moved.mp4'); assert.equal(f.item.favorite, true);
  fs.writeFileSync(path.join(f.cfg.mediaDir, 'other.mp4'), f.bytes);
  f.db.upsert({ id: 'other', relPath: 'other.mp4', filename: 'other.mp4', type: 'video' });
  result = await post(f.handlers.relink, id, { path: 'other.mp4' });
  assert.equal(result.code, 400); assert.match(result.data.error, /another media/); assert.equal(f.db.count(), 2);
  assert.equal(f.scanner.editing, false);
});

test('relink refuses different bytes, external symlinks, present copies and concurrent scans', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cfg.mediaDir, 'wrong.mp4'), 'unrelated');
  let result = await post(f.handlers.relink, f.item.id, { path: 'wrong.mp4' });
  assert.equal(result.code, 400); assert.match(result.data.error, /differs/);
  fs.writeFileSync(path.join(f.root, 'external.mp4'), f.bytes);
  fs.symlinkSync(path.join(f.root, 'external.mp4'), path.join(f.cfg.mediaDir, 'external.mp4'));
  result = await post(f.handlers.relink, f.item.id, { path: 'external.mp4' });
  assert.equal(result.code, 400); assert.match(result.data.error, /inside/);
  fs.writeFileSync(path.join(f.cfg.mediaDir, 'copy.mp4'), f.bytes);
  fs.writeFileSync(path.join(f.cfg.mediaDir, 'old.mp4'), f.bytes);
  result = await post(f.handlers.relink, f.item.id, { path: 'copy.mp4' });
  assert.equal(result.code, 400); assert.match(result.data.error, /separate copy/);
  f.scanner.scanning = true;
  result = await post(f.handlers.relink, f.item.id, { path: 'copy.mp4' });
  assert.equal(result.code, 400); assert.match(result.data.error, /scanning/);
  assert.equal(f.item.relPath, 'old.mp4'); assert.equal(f.scanner.editing, false);
});

test('artist display labels persist across scans and are searchable without renaming source folders', async t => {
  const f = fixture(t), handler = libraryHandlers(f.cfg, f.db, {}).preferences;
  const result = await post(handler, f.item.id, { creatorAlias: 'My Artist' });
  assert.equal(result.code, 200); assert.equal(result.data.item.displayCreator, 'My Artist');
  f.db.upsert({ ...f.item, creatorAlias: undefined });
  assert.equal(f.db.get(f.item.id).creatorAlias, 'My Artist');
  assert.equal(f.db.query({ q: 'my artist' }).total, 1);
  assert.equal(f.db.get(f.item.id).relPath, 'old.mp4');
  assert.equal((await post(handler, f.item.id, { creatorAlias: 'bad\nname' })).code, 400);
});
