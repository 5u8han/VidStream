'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Db } = require('../lib/db');
const { publicItem } = require('../lib/serialize');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-catalog-')),
    data = path.join(root, 'data'),
    opened = [];
  function open(cache = 'cache') {
    const db = new Db(path.join(root, cache, 'index.json'), data);
    opened.push(db);
    return db;
  }
  t.after(() => {
    for (const db of opened) {
      clearTimeout(db._saveTimer);
      db.store.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, data, open };
}
function item(id = 'clip', extra = {}) {
  return {
    id,
    relPath: 'artist/' + id + '.mp4',
    filename: id + '.mp4',
    type: 'video',
    width: 320,
    height: 180,
    duration: 30,
    mtime: '2026-01-01',
    fingerprint: '1000:123:preview-one',
    ...extra
  };
}
function event(action, details = {}) {
  return {
    id: crypto.randomUUID(),
    visitor: 'test-visitor',
    at: new Date().toISOString(),
    action,
    details
  };
}

test('legacy JSON imports once into a durable catalog with a consistent pre-migration backup', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.data, { recursive: true });
  const old = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  old.exec(
    'CREATE TABLE media_state(path TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE events(id INTEGER PRIMARY KEY,path TEXT,at TEXT,action TEXT,data TEXT);PRAGMA user_version=2;'
  );
  old
    .prepare('INSERT INTO media_state VALUES(?,?)')
    .run('artist/clip.mp4', JSON.stringify({ favorite: true, addedAt: '2020-01-01' }));
  old.close();
  fs.mkdirSync(path.join(f.root, 'cache'));
  fs.writeFileSync(path.join(f.root, 'cache', 'index.json'), JSON.stringify([item()]));
  const db = f.open(),
    first = db.get('clip');
  assert.equal(first.favorite, true);
  assert.match(first.mediaId, /^[a-f0-9-]{36}$/);
  const backup = new DatabaseSync(db.store.migrationBackup, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(
    JSON.parse(backup.prepare('SELECT data FROM media_state').get().data).favorite,
    true
  );
  backup.close();
  fs.rmSync(path.join(f.root, 'cache'), { recursive: true });
  const reopened = f.open('fresh-cache');
  assert.equal(reopened.get('clip').mediaId, first.mediaId);
  assert.equal(reopened.get('clip').favorite, true);
  assert.equal(reopened.query({}).total, 1);
  assert.equal(reopened.store.sql.prepare('PRAGMA user_version').get().user_version, 3);
});

test('relink retains identity, preferences and history while retired records remain unchanged', (t) => {
  const f = fixture(t),
    db = f.open(),
    clip = item();
  db.upsert(clip);
  db.store.update(clip, { favorite: true });
  db.store.track(clip, event('open'));
  db.store.track(clip, event('watch', { seconds: 5, position: 12 }));
  db.store.saveVariant(clip, {
    id: 'enhanced',
    sourceVersion: clip.sourceVersion,
    kind: 'enhanced',
    url: '/enhanced'
  });
  db.store.saveJob({
    id: 'job',
    itemId: clip.id,
    relPath: clip.relPath,
    filename: clip.filename,
    sourceFingerprint: clip.fingerprint,
    options: {},
    state: 'completed'
  });
  const retiredJob = db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data;
  const permanent = clip.mediaId;
  db.relocate(clip, 'renamed/new-name.mp4');
  assert.equal(clip.mediaId, permanent);
  assert.equal(clip.id, 'clip');
  assert.equal(clip.favorite, true);
  assert.equal(db.get(permanent), clip);
  assert.equal(db.store.activityStats(clip).opens, 1);
  assert.equal(db.store.activityStats(clip).position, 12);
  assert.equal(db.store.history(clip)[0].action, 'relocated');
  assert.equal(db.store.variants(clip)[0].id, 'enhanced');
  assert.equal(db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data, retiredJob);
  assert.equal(db.store.job('job').relPath, 'artist/clip.mp4');
  const again = f.open('new-cache');
  assert.equal(again.get('clip').relPath, 'renamed/new-name.mp4');
  assert.equal(again.get('clip').mediaId, permanent);
  db.upsert(item('other', { relPath: 'occupied.mp4' }));
  assert.throws(() => db.relocate(clip, 'occupied.mp4'), /another media/);
  assert.equal(clip.relPath, 'renamed/new-name.mp4');
});

test('byte-identical separate copies are distinct and old slug aliases survive a catalog reindex', (t) => {
  const f = fixture(t),
    db = f.open(),
    one = item('one', { sourceHash: 'same-bytes' }),
    two = item('two', { sourceHash: 'same-bytes' });
  db.upsert(one);
  db.upsert(two);
  assert.notEqual(one.mediaId, two.mediaId);
  db.store.update(one, { favorite: true });
  assert.equal(two.favorite, false);
  db.upsert(item('changed-slug', { relPath: one.relPath, sourceHash: 'same-bytes' }));
  assert.equal(db.get('one').id, 'changed-slug');
  assert.equal(db.get('changed-slug').mediaId, one.mediaId);
  assert.equal(db.get('changed-slug').favorite, true);
  assert.equal(db.count(), 2);
});

test('catalog recipe and source updates preserve retired job records verbatim', (t) => {
  const f = fixture(t),
    db = f.open(),
    clip = item();
  db.upsert(clip);
  const options = { smoothing: 'ffmpeg' };
  db.store.saveJob({
    id: 'job',
    itemId: clip.id,
    sourceFingerprint: clip.fingerprint,
    options,
    state: 'completed'
  });
  const original = db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data;
  const same = item('clip', { fingerprint: '1000:123:preview-two' });
  db.upsert(same);
  assert.equal(same.sourceVersion, clip.sourceVersion);
  assert.equal(db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data, original);
  const hashed = item('clip', { fingerprint: '1000:123:preview-three', sourceHash: 'sha256-here' });
  db.upsert(hashed);
  assert.equal(db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data, original);
  db.upsert(item('clip', { fingerprint: '2000:999:preview-three', sourceHash: 'changed-bytes' }));
  assert.equal(db.store.sql.prepare('SELECT data FROM enhancement_jobs WHERE id=?').get('job').data, original);
});

test('retired variants survive restart as inert data while playback uses the local original', (t) => {
  const f = fixture(t),
    db = f.open(),
    clip = item();
  db.upsert(clip);
  db.store.saveVariant(clip, {
    id: 'result',
    kind: 'enhanced',
    path: '/private/result.mp4',
    sourceVersion: clip.sourceVersion,
    url: '/api/enhancements/result/video',
    tech: { frameRate: 60 }
  });
  db.store.update(clip, { activeVariant: 'result' });
  const again = f.open('different-cache'),
    saved = again.get('clip'),
    cfg = { thumbnailSizes: [320], posterSizes: [320], largeSizes: [1280] };
  const serialized = publicItem(saved, cfg, true);
  assert.match(serialized.urls.full, /\/media\/clip\/original/);
  assert.match(serialized.urls.original, /\/media\/clip\/original/);
  assert.equal(serialized.activeVariantTech, undefined);
  assert.equal(serialized.variants, undefined);
  assert.equal(serialized.activeVariant, undefined);
  assert.equal(publicItem(saved, cfg, false).variants, undefined);
  assert.equal(again.store.variants(saved)[0].path, '/private/result.mp4');
  saved.sourceVersion = 'new-original';
  assert.match(publicItem(saved, cfg, true).urls.full, /\/media\/clip\/original/);
});

test('SQLite paging, literal search and activity rediscovery agree with neighbors', (t) => {
  const f = fixture(t),
    db = f.open();
  for (const id of ['a', 'b', 'c'])
    db.upsert(item(id, { filename: id === 'c' ? '100% real.mp4' : id + '.mp4' }));
  db.store.track(db.get('b'), event('open'));
  db.store.track(db.get('b'), event('watch', { seconds: 5, position: 8 }));
  assert.equal(db.query({ sort: 'recent' }).items[0].id, 'b');
  assert.deepEqual(
    db.query({ sort: 'continue' }).items.map((i) => i.id),
    ['b']
  );
  assert.equal(db.query({ sort: 'less-seen' }).items.at(-1).id, 'b');
  assert.deepEqual(
    db.query({ q: '100%' }).items.map((i) => i.id),
    ['c']
  );
  const first = db.query({ sort: 'random', seed: 'stable', q: '.mp4', limit: 1 });
  const second = db.query({
    sort: 'random',
    seed: 'stable',
    q: '.mp4',
    cursor: first.nextCursor,
    limit: 1
  });
  assert.equal(
    db.neighbors(first.items[0].id, { sort: 'random', seed: 'stable', q: '.mp4' }).next.id,
    second.items[0].id
  );
});

test('poster-first imports expose usable originals until their richer derivatives are ready', () => {
  const cfg = { thumbnailSizes: [320], posterSizes: [320], largeSizes: [1280] };
  const importing = item('new', {
    processing: { stage: 'preview', previewReady: false, analysisReady: false }
  });
  const video = publicItem(importing, cfg, true);
  assert.equal(video.processing.previewReady, false);
  assert.equal(video.urls.preview, null);
  assert.match(video.urls.full, /\/original/);
  assert.equal(video.availability, 'available');
  const photo = publicItem({ ...importing, type: 'photo' }, cfg, true);
  assert.match(photo.urls.full, /\/original/);
  assert.equal(photo.urls.fullSrcset, null);
  const ready = publicItem(
    { ...importing, type: 'photo', processing: { previewReady: true } },
    cfg,
    true
  );
  assert.match(ready.urls.full, /\/large/);
  assert.ok(ready.urls.fullSrcset);
  const refreshing = publicItem(
    { ...importing, processing: { stage: 'analysis', previewReady: true } },
    cfg,
    true
  );
  assert.match(refreshing.urls.preview, /\/preview/);
  const failed = publicItem(
    { ...importing, processing: { stage: 'failed', previewReady: true, error: 'private details' } },
    cfg,
    false
  );
  assert.equal(failed.processing.error, undefined);
  assert.match(failed.urls.preview, /\/preview/);
});
