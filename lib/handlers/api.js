'use strict';
const { publicItem } = require('../serialize');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');

const VALID_SORTS = new Set(['desc', 'asc', 'name-asc', 'name-desc', 'random']);
const FIXED_HAS = new Set(['face', 'cat', 'text']);
// Object-class values are dynamic (whatever YOLO actually detected in
// this library, e.g. "dining table", "cell phone"), so they can't be a
// fixed whitelist -- just sanity-bound the shape instead.
const HAS_PATTERN = /^[a-z][a-z ]{0,30}$/;

function parseQuery(url) {
  const q = new URL(url, 'http://x').searchParams;
  const sort = VALID_SORTS.has(q.get('sort')) ? q.get('sort') : 'desc';
  const rawHas = (q.get('has') || '').trim().toLowerCase();
  const has = FIXED_HAS.has(rawHas) || HAS_PATTERN.test(rawHas) ? rawHas || null : null;
  return {
    type: q.get('type') || null,
    album: q.get('album') || null,
    has,
    q: (q.get('q') || '').trim().slice(0, 200),
    sort,
    seed: q.get('seed') || '',
    cursor: q.get('cursor') || null,
    limit: Math.min(Math.max(parseInt(q.get('limit') || '60', 10) || 60, 1), 120),
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function itemsHandler(cfg, db) {
  return (req, res) => {
    const q = parseQuery(req.url);
    const admin = isAdmin(req, cfg);
    const { items, nextCursor, total } = db.query({ ...q, guestOnly: !admin });
    sendJson(res, 200, {
      items: items.map((i) => publicItem(i, cfg)),
      nextCursor,
      total,
      albums: db.albums(),
      objectClasses: db.objectClasses(),
      isAdmin: admin,
    });
  };
}

function itemHandler(cfg, db) {
  return (req, res, params) => {
    const item = db.get(params.id);
    const admin = isAdmin(req, cfg);
    if (!item || (item.guest !== true && !admin)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const q = parseQuery(req.url);
    // Neighbors are computed within the same filter/sort the grid the
    // person is browsing is using, so prev/next matches what they see
    // (e.g. filtered to Videos only -> next is the next video, not the
    // next item in the unfiltered stream).
    const nb = db.neighbors(item.id, { ...q, guestOnly: !admin });
    sendJson(res, 200, {
      item: publicItem(item, cfg),
      index: nb.index,
      total: nb.total,
      prev: nb.prev ? publicItem(nb.prev, cfg) : null,
      next: nb.next ? publicItem(nb.next, cfg) : null,
    });
  };
}

function rescanHandler(cfg, db, scanner) {
  return async (req, res) => {
    const result = await scanner.scan();
    sendJson(res, 200, result);
  };
}

function healthHandler(cfg, db) {
  return (req, res) => {
    sendJson(res, 200, { ok: true, items: db.count() });
  };
}

// Counts (photos/videos/unsupported/failed/total) and, for admins, the
// actual file lists -- so nothing silently vanishes from view.
function libraryStatusHandler(cfg, scanner) {
  return (req, res) => {
    if (isAdmin(req, cfg)) {
      return sendJson(res, 200, { stats: scanner.stats, unsupported: scanner.unsupported, failed: scanner.failed });
    }
    // Signed-out visitors (when the admin/guest system is on) only learn
    // about what they're allowed to see -- library-wide totals would leak
    // how much private content exists.
    let photos = 0;
    let videos = 0;
    for (const item of scanner.db.items.values()) {
      if (item.guest !== true) continue;
      if (item.type === 'photo') photos++; else videos++;
    }
    sendJson(res, 200, {
      stats: { photoCount: photos, videoCount: videos, unsupportedCount: 0, failedCount: 0, total: photos + videos },
      unsupported: [],
      failed: [],
    });
  };
}

function requireAdmin(cfg, req, res) {
  if (isAdmin(req, cfg)) return true;
  sendJson(res, 403, { error: 'Admin sign-in required' });
  return false;
}

function setItemVisibilityHandler(cfg, db) {
  return async (req, res, params) => {
    if (!requireAdmin(cfg, req, res)) return;
    const item = db.get(params.id);
    if (!item) return sendJson(res, 404, { error: 'not found' });
    const body = await readJsonBody(req);
    const updated = db.setGuest(item.id, body.guest === true);
    sendJson(res, 200, { item: publicItem(updated, cfg) });
  };
}

function setAlbumVisibilityHandler(cfg, db) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const body = await readJsonBody(req);
    if (!body.album) return sendJson(res, 400, { error: 'album is required' });
    const changed = db.setGuestForAlbum(body.album, body.guest === true);
    sendJson(res, 200, { changed });
  };
}

function duplicatesHandler(cfg, db) {
  return (req, res) => {
    const admin = isAdmin(req, cfg);
    const groups = db.duplicateGroups({ threshold: cfg.duplicateThreshold, guestOnly: !admin });
    sendJson(res, 200, {
      groups: groups.map((g) => g.map((i) => publicItem(i, cfg))),
    });
  };
}

module.exports = {
  itemsHandler,
  itemHandler,
  rescanHandler,
  healthHandler,
  libraryStatusHandler,
  setItemVisibilityHandler,
  setAlbumVisibilityHandler,
  duplicatesHandler,
  sendJson,
  parseQuery,
};
