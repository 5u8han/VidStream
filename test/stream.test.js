'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Db } = require('../lib/db');
const { Scanner } = require('../lib/scanner');
const { AiManager } = require('../lib/ai-manager');
const { itemsHandler, rescanHandler, dashboardHandler, healthHandler } = require('../lib/handlers/api');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
  return { dir, cacheDir: path.join(dir, 'cache'), mediaDir: path.join(dir, 'media') };
}
function record(id, album, type, opts = {}) {
  return { id, type, album, filename: `${id}.${type === 'video' ? 'mp4' : 'jpg'}`, relPath: `${album}/${id}.jpg`,
    dateTaken: '2026-01-05T00:00:00.000Z', addedAt: '2026-10-03T00:00:00.000Z',
    mtime: '2026-01-06T00:00:00.000Z', width: 1920, height: 1080, guest: false,
    objects: ['car'], ...opts };
}
function fakeRes() {
  return { status: 0, headers: {}, body: null,
    writeHead(n, h) { this.status = n; this.headers = h; },
    end(raw) { this.body = JSON.parse(raw); } };
}
test('creator fallback, group order, date filters, resolution and guest-only catalog', () => {
  const f = fixture(); const db = new Db(path.join(f.cacheDir, 'index.json'));
  db.upsert(record('a', 'Creator A/Set 2', 'photo', { guest: true }));
  db.upsert(record('b', 'Creator B', 'video', { dateTaken: '2025-08-04T00:00:00.000Z', width: 720, height: 480 }));
  db.upsert(record('c', 'Creator A/Set 1', 'video', { guest: true }));
  assert.deepEqual(db.creators(true), ['Creator A']);
  assert.deepEqual(db.albums(true), ['Creator A/Set 1', 'Creator A/Set 2']);
  assert.deepEqual(db.query({ sort: 'creator' }).items.map((x) => x.id), ['a', 'c', 'b']);
  assert.equal(db.query({ creator: 'Creator A', guestOnly: true }).total, 2);
  assert.equal(db.query({ resolution: 720, guestOnly: true }).total, 2);
  assert.equal(db.query({ resolution: 1080 }).total, 2);
  assert.equal(db.query({ dateField: 'imported', dateFrom: '2026-10-01', dateTo: '2026-10-04' }).total, 3);
  assert.equal(db.query({ dateField: 'created', dateFrom: '2026-01-01' }).total, 2);
  const cfg = { adminPassword: 'secret', ldapUrl: '', thumbnailSizes: [320], posterSizes: [480], largeSizes: [1280] };
  const res = fakeRes(); itemsHandler(cfg, db)({ url: '/api/items?sort=creator', headers: {} }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.creators, ['Creator A']);
  assert.equal(res.body.items.some((x) => x.filename === 'b.mp4'), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
test('rescan and dashboard cannot be triggered by guests; health does not reveal file count', async () => {
  const f = fixture(); const db = new Db(path.join(f.cacheDir, 'index.json'));
  db.upsert(record('a', 'Private', 'photo'));
  const cfg = { adminPassword: 'secret' };
  const r = fakeRes(); await rescanHandler(cfg, db, { scan: () => { throw Error('must not run'); } })({ headers: {} }, r);
  assert.equal(r.status, 403);
  const dash = fakeRes(); dashboardHandler(cfg, db, { history: [] })({ headers: {} }, dash);
  assert.equal(dash.status, 403);
  const health = fakeRes(); healthHandler(cfg, db)({ headers: {} }, health);
  assert.deepEqual(health.body, { ok: true });
  fs.rmSync(f.dir, { recursive: true, force: true });
});
test('missing NAS folder must preserve previously indexed media and record failed directory', async () => {
  const f = fixture(); const db = new Db(path.join(f.cacheDir, 'index.json'));
  db.upsert(record('a', 'Creator A', 'photo'));
  const cfg = { mediaDir: f.mediaDir, cacheDir: f.cacheDir, processingConcurrency: 1,
    thumbnailSizes: [320], posterSizes: [320], largeSizes: [640], videoPreviewFps: 60 };
  const scanner = new Scanner(cfg, db);
  const result = await scanner.scan();
  assert.equal(result.removed, 0);
  assert.equal(db.count(), 1);
  assert.equal(scanner.walkErrors.length, 1);
  assert.ok(scanner.lastScan.durationMs >= 0);
  assert.ok(fs.existsSync(path.join(f.cacheDir, 'scan-history.json')));
  fs.rmSync(f.dir, { recursive: true, force: true });
});
test('AI model selection is whitelisted and disabled without weights', () => {
  const f = fixture(); const cfg = { ...f, enableObjectDetection: false };
  const ai = new AiManager(cfg);
  assert.equal(ai.status().effective, false);
  assert.throws(() => ai.update({ selected: '../../etc/passwd' }), /Invalid model/);
  assert.throws(() => ai.update({ device: 'cuda:99' }), /Invalid compute/);
  assert.equal(ai.update({ selected: 'yolov8s', device: 'cpu', enabled: true }).effective, false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
