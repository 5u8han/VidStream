'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageHandler } = require('../lib/handlers/page');
const { setSessionCookie } = require('../lib/auth');

function fixture() {
  const cfg = {
    title: 'Fixture library', url: 'http://fixture.local:4000',
    adminPassword: 'fixture-passphrase', sessionSecret: 'fixture-page-session-secret',
    sessionCookieName: 'stream_session_page_fixture',
    thumbnailSizes: [320], posterSizes: [480], largeSizes: [1280],
  };
  const savedUI = { 'stream-theme': 'golden-hour', note: "Private & owner's choice" };
  const item = {
    id: 'secret-item-id', filename: 'secret-wedding-fixture.jpg', type: 'photo',
    relPath: 'private/secret-wedding-fixture.jpg', album: 'Private wedding folder',
    width: 640, height: 480, fingerprint: 'fixture-bytes', guest: false,
  };
  const db = {
    get(id) { return id === item.id ? item : null; },
    store: { setting(key, fallback) { return key === 'ui' ? savedUI : key === 'tracking' ? false : fallback; } },
  };
  let cookie;
  setSessionCookie({ setHeader(_name, value) { cookie = value.split(';')[0]; } }, cfg, { headers: {} });
  return { cfg, db, item, savedUI, cookie };
}
function render(cfg, db, params, cookie) {
  let cookieReads = 0;
  const headers = {};
  Object.defineProperty(headers, 'cookie', { get() { cookieReads++; return cookie; } });
  const response = { status: null, headers: null, html: null };
  pageHandler(cfg, db)({ headers }, {
    writeHead(status, values) { response.status = status; response.headers = values; },
    end(html) { response.html = html; },
  }, params);
  function attribute(name) {
    const raw = response.html.match(new RegExp(name + "='([^']*)'"))[1];
    return raw ? JSON.parse(raw.replace(/&amp;|&#39;/g, value => value === '&amp;' ? '&' : "'")) : null;
  }
  return { ...response, config: attribute('data-config'), initial: attribute('data-initial'), cookieReads };
}

test('an authenticated dead media link retains owner controls, preferences and tracking state', () => {
  const { cfg, db, savedUI, cookie } = fixture();
  const page = render(cfg, db, { id: 'removed-old-link' }, cookie);
  assert.equal(page.status, 404);
  assert.equal(page.headers['Cache-Control'], 'no-cache');
  assert.equal(page.config.isAdmin, true, 'A stale link must not hide owner-only settings');
  assert.deepEqual(page.config.savedUI, savedUI);
  assert.equal(page.config.tracking, false);
  assert.equal(page.initial, null);
  assert.equal(page.cookieReads, 1, 'The page determines the request role once');
});

test('guest private and nonexistent links return the same shell without private metadata', () => {
  const { cfg, db, item } = fixture();
  const privatePage = render(cfg, db, { id: item.id });
  const missingPage = render(cfg, db, { id: 'nonexistent' });
  assert.equal(privatePage.status, 404);
  assert.equal(missingPage.status, 404);
  assert.equal(privatePage.html, missingPage.html, 'A missing link must not reveal whether private media exists');
  assert.equal(privatePage.headers['Cache-Control'], 'no-cache');
  assert.equal(privatePage.config.isAdmin, false);
  assert.deepEqual(privatePage.config.savedUI, {});
  assert.equal(privatePage.config.tracking, false);
  assert.equal(privatePage.initial, null);
  for (const secret of [item.id, item.filename, item.relPath, item.album, "owner's choice"])
    assert.equal(privatePage.html.includes(secret), false, secret + ' must not leak through HTML or OG metadata');
  assert.match(privatePage.html, /property="og:image" content="http:\/\/fixture\.local:4000\/social-preview\.png"/);
});

test('malformed unrelated cookies do not break the owner page shell', () => {
  const { cfg, db, cookie } = fixture();
  const page = render(cfg, db, { id: 'removed-link' }, 'other=%E0%A4%A; ' + cookie);
  assert.equal(page.status, 404);
  assert.equal(page.config.isAdmin, true);
});

test('normal gallery and permitted media pages retain their existing session and initial-item behavior', () => {
  const { cfg, db, item, savedUI, cookie } = fixture();
  const ownerGallery = render(cfg, db, undefined, cookie);
  assert.equal(ownerGallery.status, 200);
  assert.equal(ownerGallery.config.isAdmin, true);
  assert.deepEqual(ownerGallery.config.savedUI, savedUI);
  assert.equal(ownerGallery.initial, null);
  assert.equal(ownerGallery.config.version, require('../package.json').version);
  assert.equal(ownerGallery.config.features.nodes, false);
  assert.ok(ownerGallery.html.includes('/settings.js?v=' + require('../package.json').version));
  const ownerMedia = render(cfg, db, { id: item.id }, cookie);
  assert.equal(ownerMedia.status, 200);
  assert.equal(ownerMedia.config.isAdmin, true);
  assert.equal(ownerMedia.initial.id, item.id);
  assert.equal(ownerMedia.initial.filename, item.filename);
  assert.equal(ownerMedia.cookieReads, 1);
  item.guest = true;
  const guestMedia = render(cfg, db, { id: item.id });
  assert.equal(guestMedia.status, 200);
  assert.equal(guestMedia.config.isAdmin, false);
  assert.deepEqual(guestMedia.config.savedUI, {});
  assert.equal(guestMedia.initial.id, item.id);
});
