'use strict';
const { publicItem } = require('../serialize');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');

const VALID_SORTS = new Set(['desc', 'asc', 'name-asc', 'name-desc', 'random', 'creator', 'recent', 'continue', 'less-seen']);
const FIXED_HAS = new Set(['face', 'cat', 'text']);
// Object-class values are dynamic (whatever YOLO actually detected in
// this library, e.g. "dining table", "cell phone"), so they can't be a
// fixed whitelist -- just sanity-bound the shape instead.
const HAS_PATTERN = /^[a-z][a-z ]{0,30}$/;

function dateParam(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
}
function parseQuery(url) {
  const q = new URL(url, 'http://x').searchParams;
  const sort = VALID_SORTS.has(q.get('sort')) ? q.get('sort') : 'desc';
  const rawHas = (q.get('has') || '').trim().toLowerCase();
  const has = FIXED_HAS.has(rawHas) || HAS_PATTERN.test(rawHas) ? rawHas || null : null;
  return {
    type: q.get('type') || null,
    album: q.get('album') || null,
    creator: q.get('creator') || null,
    dateField: q.get('dateField') === 'imported' ? 'imported' : 'created',
    dateFrom: dateParam(q.get('dateFrom')),
    dateTo: dateParam(q.get('dateTo')),
    resolution: [720, 1080, 2160].includes(Number(q.get('resolution'))) ? Number(q.get('resolution')) : 0,
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
      albums: db.albums(!admin),
      creators: db.creators(!admin),
      objectClasses: db.objectClasses(!admin),
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
      item: publicItem(item, cfg, admin),
      index: nb.index,
      total: nb.total,
      prev: nb.prev ? publicItem(nb.prev, cfg) : null,
      next: nb.next ? publicItem(nb.next, cfg) : null,
    });
  };
}

function rescanHandler(cfg, db, scanner) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const body = await readJsonBody(req);
    const result = await scanner.scan({ force: body.force === true });
    sendJson(res, 200, result);
  };
}

function healthHandler(cfg, db) {
  return (req, res) => {
    sendJson(res, 200, { ok: true });
  };
}

// Counts (photos/videos/unsupported/failed/total) and, for admins, the
// actual file lists -- so nothing silently vanishes from view.
function libraryStatusHandler(cfg, scanner) {
  return (req, res) => {
    if (isAdmin(req, cfg)) {
      return sendJson(res, 200, { stats: scanner.stats, unsupported: scanner.unsupported, failed: scanner.failed, walkErrors: scanner.walkErrors, lastScan: scanner.lastScan, scanning: scanner.scanning });
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
      stats: { photoCount: photos, videoCount: videos, unsupportedCount: 0, failedCount: 0, unreadableDirectoryCount: 0, total: photos + videos },
      unsupported: [],
      failed: [],
    });
  };
}

// Aggregates only index metadata; no expensive media probe is done on page load.
const { hardwareSummary } = require('../ai-manager');
function aiStatusHandler(cfg, ai) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    sendJson(res, 200, { ...ai.status(), hardware: await hardwareSummary() });
  };
}
function aiUpdateHandler(cfg, ai) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    try { sendJson(res, 200, ai.update(await readJsonBody(req))); }
    catch (err) { sendJson(res, 400, { error: err.message }); }
  };
}
function aiInstallHandler(cfg, ai) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const body = await readJsonBody(req);
    try { sendJson(res, 200, await ai.install(body.id)); }
    catch (err) { sendJson(res, 400, { error: String(err.message).slice(0, 250) }); }
  };
}

function dashboardFilesHandler(cfg, db) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const params = new URL(req.url, 'http://localhost').searchParams;
    const offset = Math.max(0, Math.min(10000000, Number.parseInt(params.get('offset') || '0', 10) || 0));
    const limit = Math.max(1, Math.min(200, Number.parseInt(params.get('limit') || '100', 10) || 100));
    const items = Array.from(db.items.values()).sort((a, b) =>
      (a.creator || a.album || '').localeCompare(b.creator || b.album || '') || a.filename.localeCompare(b.filename));
    sendJson(res, 200, {
      total: items.length,
      items: items.slice(offset, offset + limit).map((i) => ({
        filename: i.filename, creator: i.creator || (i.album ? i.album.split('/')[0] : '(Unsorted)'),
        album: i.album, type: i.type, width: i.width, height: i.height,
        bytes: i.size, date: i.dateTaken || i.mtime,
      })),
    });
  };
}

function dashboardHandler(cfg, db, scanner) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const creators = new Map(), formats = new Map(), resolutions = new Map();
    const totals = { photos: 0, videos: 0, bytes: 0, indexed: db.count() };
    for (const item of db.items.values()) {
      const creator = item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)');
      const c = creators.get(creator) || { name: creator, photos: 0, videos: 0, bytes: 0 };
      c[item.type === 'video' ? 'videos' : 'photos']++;
      totals[item.type === 'video' ? 'videos' : 'photos']++;
      c.bytes += item.size || 0;
      totals.bytes += item.size || 0;
      creators.set(creator, c);
      const ext = (item.ext || '').toLowerCase();
      formats.set(ext, (formats.get(ext) || 0) + 1);
      const edge = Math.min(item.width || 0, item.height || 0);
      const resolution = edge >= 2160 ? '4K+' : edge >= 1080 ? '1080p+' : edge >= 720 ? '720p+' : 'Below 720p / unknown';
      resolutions.set(resolution, (resolutions.get(resolution) || 0) + 1);
    }
    const ranked = (entries) => [...entries].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    sendJson(res, 200, {
      totals, lastScan: scanner.lastScan, history: scanner.history,
      creators: [...creators.values()].sort((a, b) => b.photos + b.videos - a.photos - a.videos),
      formats: ranked(formats), resolutions: ranked(resolutions),
      unsupported: scanner.unsupported, failed: scanner.failed, walkErrors: scanner.walkErrors,
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
      groups: groups.map((g) => g.map((i) => publicItem(i, cfg, admin))),
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
  dashboardHandler,
  dashboardFilesHandler,
  aiStatusHandler, aiUpdateHandler, aiInstallHandler,
  sendJson,
  parseQuery,
};
