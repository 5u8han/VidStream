'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Db } = require('../lib/db');
const { normalizePath, normalizeFolders, visibleFolders, SETTING } = require('../lib/folder-collections');
const { folderCollectionsHandlers } = require('../lib/handlers/folders');
const { itemsHandler, itemHandler } = require('../lib/handlers/api');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-folders-'));
  const data = path.join(root, 'data');
  const opened = [];
  function open() {
    const db = new Db(path.join(root, 'cache', 'index.json'), data);
    opened.push(db);
    return db;
  }
  t.after(() => {
    for (const db of opened) db.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { open };
}
function insert(db, id, relPath, extra = {}) {
  const album = path.posix.dirname(relPath);
  db.upsert({ id, relPath, filename: path.posix.basename(relPath), type: 'video', album,
    width: 320, height: 180, duration: 10, fingerprint: id, mtime: '2026-01-01', ...extra });
}
function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
}
function req(url = '/', body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.url = url; request.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  return request;
}
function ownerConfig() { return { thumbnailSizes: [320], posterSizes: [320], largeSizes: [640] }; }

test('folder collection validation permits nested relative paths and rejects machine paths and traversal', () => {
  assert.equal(normalizePath('Personal/2026/Artist/'), 'Personal/2026/Artist');
  assert.equal(normalizePath('.'), '');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath('Artist %_ /日本語'), 'Artist %_ /日本語');
  for (const value of ['/Users/private', '//server/share', 'C:/Media', 'C:\\Media', '../private', 'a/../b', 'a/./b', 'a//b', 'a\u0000b'])
    assert.throws(() => normalizePath(value), /relative|segments|machine/);
  assert.throws(() => normalizeFolders([{ id: 'same', name: 'A', path: 'A' }, { id: 'same', name: 'B', path: 'B' }]), /unique/);
  assert.throws(() => normalizeFolders([{ name: '', path: 'A' }]), /name/);
  assert.throws(() => normalizeFolders(Array.from({ length: 65 }, () => ({ name: 'A', path: 'A' }))), /64/);
  const result = normalizeFolders([{ name: ' Anime ', path: 'Anime/' }]);
  assert.equal(result[0].name, 'Anime'); assert.equal(result[0].path, 'Anime');
  assert.match(result[0].id, /^[a-f0-9-]{36}$/);
});

test('SQLite collection queries include descendants without sibling or SQL-wildcard matches', (t) => {
  const db = fixture(t).open();
  insert(db, 'a', 'Private/2026/a.mp4'); insert(db, 'b', 'Private/2026/Artist/b.mp4');
  insert(db, 'c', 'Private-more/2026/c.mp4'); insert(db, 'd', 'Private0/d.mp4');
  insert(db, 'literal', 'A%_/Nested/literal.mp4'); insert(db, 'wildcard', 'Anything/Nested/wildcard.mp4');
  insert(db, 'quote', "Artist's/2026/q.mp4");
  assert.deepEqual(db.query({ folderPath: 'Private', sort: 'name-asc' }).items.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(db.query({ folderPath: 'Private/2026/Artist' }).items.map((item) => item.id), ['b']);
  assert.deepEqual(db.query({ folderPath: 'A%_' }).items.map((item) => item.id), ['literal']);
  assert.deepEqual(db.query({ folderPath: "Artist's" }).items.map((item) => item.id), ['quote']);
  assert.equal(db.query({ folderPath: '' }).total, 7);
  assert.equal(db.query({ folderPath: 'Private', album: 'Private/2026/Artist' }).total, 1);
  assert.equal(db.query({ folderPath: 'Private', creator: 'Private-more' }).total, 0);
  const page = db.query({ folderPath: 'Private', sort: 'name-asc', limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.nextCursor, 'a');
  assert.deepEqual(db.query({ folderPath: 'Private', sort: 'name-asc', cursor: page.nextCursor, limit: 1 }).items.map((item) => item.id), ['b']);
  const neighbors = db.neighbors('a', { folderPath: 'Private', sort: 'name-asc' });
  assert.equal(neighbors.index, 0); assert.equal(neighbors.total, 2); assert.equal(neighbors.next.id, 'b');
  assert.equal(db.neighbors('c', { folderPath: 'Private' }).index, -1);
});

test('manual folder API persists choices, denies guest edits and omits private collection names and paths', async (t) => {
  const f = fixture(t), db = f.open(), cfg = ownerConfig();
  insert(db, 'public', 'Public/Nested/a.mp4', { guest: true });
  insert(db, 'private', 'Private/Nested/b.mp4');
  const handlers = folderCollectionsHandlers(cfg, db), saved = response();
  await handlers.update(req('/', { folders: [{ id: 'public', name: 'Shared', path: 'Public' }, { id: 'private', name: 'Sensitive name', path: 'Private' }] }), saved);
  assert.equal(saved.status, 200);
  const reopened = f.open();
  assert.deepEqual(reopened.store.setting(SETTING), saved.body.folders);
  const guestHandlers = folderCollectionsHandlers({ adminPassword: 'secret' }, reopened), visible = response();
  guestHandlers.get(req(), visible);
  assert.deepEqual(visible.body.folders, [{ id: 'public', name: 'Shared' }]);
  assert.equal(JSON.stringify(visible.body).includes('Sensitive'), false);
  assert.equal(JSON.stringify(visible.body).includes('Public'), false);
  const denied = response();
  await guestHandlers.update(req('/', { folders: [] }), denied);
  assert.equal(denied.status, 403); assert.equal(reopened.store.setting(SETTING).length, 2);
  const invalid = response();
  await handlers.update(req('/', { folders: [{ name: 'Escape', path: '../Private' }] }), invalid);
  assert.equal(invalid.status, 400); assert.equal(db.store.setting(SETTING).length, 2);
});

test('scoped item APIs preserve pagination and neighbors; unknown or guest-hidden folder IDs never fall back to all media', (t) => {
  const db = fixture(t).open(), cfg = ownerConfig();
  insert(db, 'a', 'Private/2026/a.mp4'); insert(db, 'b', 'Private/2026/b.mp4');
  insert(db, 'public', 'Public/c.mp4', { guest: true });
  db.store.setSetting(SETTING, [{ id: 'private', name: 'Private', path: 'Private' }, { id: 'public', name: 'Public', path: 'Public' }]);
  const page = response();
  itemsHandler(cfg, db)(req('/api/items?folder=private&sort=name-asc&limit=1'), page);
  assert.equal(page.status, 200); assert.equal(page.body.total, 2); assert.equal(page.body.nextCursor, 'a');
  assert.deepEqual(page.body.albums, ['Private/2026']); assert.deepEqual(page.body.creators, ['Private']);
  const detail = response();
  itemHandler(cfg, db)(req('/api/item/a?folder=private&sort=name-asc'), detail, { id: 'a' });
  assert.equal(detail.body.total, 2); assert.equal(detail.body.next.id, 'b');
  const unknown = response();
  itemsHandler(cfg, db)(req('/api/items?folder=missing'), unknown);
  assert.equal(unknown.status, 404); assert.equal(unknown.body.items, undefined);
  const malformed = response();
  itemsHandler(cfg, db)(req('/api/items?folder=../Private'), malformed);
  assert.equal(malformed.status, 404);
  const guest = response();
  itemsHandler({ ...cfg, adminPassword: 'secret' }, db)(req('/api/items?folder=private'), guest);
  assert.equal(guest.status, 404);
  const visible = response();
  itemsHandler({ ...cfg, adminPassword: 'secret' }, db)(req('/api/items?folder=public'), visible);
  assert.equal(visible.body.total, 1); assert.deepEqual(visible.body.folders, [{ id: 'public', name: 'Public' }]);
  db.filterOptions = () => { throw Error('Legacy metadata must not be enumerated'); };
  const lightweight = response();
  itemsHandler(cfg, db)(req('/api/items?folder=private&metadata=0'), lightweight);
  assert.equal(lightweight.status, 200); assert.deepEqual(lightweight.body.albums, []);
});

test('folder mutations require same-origin JSON even for an authenticated owner', async (t) => {
  const db = fixture(t).open(), handlers = folderCollectionsHandlers(ownerConfig(), db);
  for (const [headers, status] of [
    [{ 'content-type': 'text/plain' }, 415],
    [{ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 415],
    [{ 'content-type': 'application/json', host: 'localhost:4000', origin: 'http://other.invalid' }, 403]
  ]) {
    const request = req('/', { folders: [] }), result = response();
    request.headers = headers;
    await handlers.update(request, result);
    assert.equal(result.status, status);
    assert.equal(db.store.setting(SETTING), null);
  }
});

test('bounded metadata and guest-folder caches refresh after catalog imports, deletion and visibility changes', (t) => {
  const db = fixture(t).open();
  insert(db, 'a', 'Private/A/a.mp4', { objects: ['car'] });
  db.store.setSetting(SETTING, [{ id: 'private', name: 'Private', path: 'Private' }]);
  assert.deepEqual(visibleFolders(db, false), []);
  assert.deepEqual(db.filterOptions(true, 'Private').albums, []);
  db.setGuest('a', true);
  assert.deepEqual(visibleFolders(db, false), [{ id: 'private', name: 'Private' }]);
  assert.deepEqual(db.filterOptions(true, 'Private').objectClasses, ['car']);
  insert(db, 'b', 'Private/B/b.mp4', { guest: true, objects: ['cat'] });
  assert.deepEqual(db.filterOptions(true, 'Private').albums, ['Private/A', 'Private/B']);
  db.setGuestForAlbum('Private/A', false);
  assert.deepEqual(db.filterOptions(true, 'Private').albums, ['Private/B']);
  db.remove('b');
  assert.deepEqual(visibleFolders(db, false), []);
  for (let i = 0; i < 50; i++) db.filterOptions(false, 'Folder ' + i);
  assert.equal(db._filterOptionsCache.size, 16);
});
