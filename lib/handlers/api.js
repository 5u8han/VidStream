'use strict';
const { publicItem, videoPreviewUrl } = require('../serialize');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');
const { resolveFolder, folders } = require('../folder-collections');
const { posix } = require('node:path');
const { serveFile, resolveMediaSource } = require('../serve-file');

const VALID_SORTS = new Set(['desc', 'asc', 'name-asc', 'name-desc', 'random', 'creator', 'recent', 'continue', 'less-seen']);
const FIXED_HAS = new Set(['face', 'cat', 'text']);
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
    folder: q.get('folder') || null,
    includeMetadata: q.get('metadata') !== '0',
    includeTotal: q.get('total') !== '0',
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
    'Cache-Control': 'private, no-store',
  });
  res.end(body);
}

function itemsHandler(cfg, db) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const q = parseQuery(req.url);
    let folder;
    try { folder = resolveFolder(db, q.folder); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const folderPath = folder?.path || '';
    const { items, nextCursor, total } = db.query({ ...q, folderPath });
    sendJson(res, 200, {
      items: items.map((i) => publicItem(i, cfg)),
      nextCursor,
      total,
      ...(q.includeMetadata ? db.filterOptions(folderPath) : { albums: [], creators: [], objectClasses: [] }),
      folders: folders(db),
      folder: folder?.id || null,
      isAdmin: true,
    });
  };
}

function readyPreviewsHandler(cfg, db) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const ids = new URL(req.url, 'http://localhost').searchParams.getAll('id').slice(0, 64);
    const previews = [];
    for (const id of new Set(ids)) {
      const item = db.get(id);
      if (!item || item.availability === 'missing' || item.availability === 'offline') continue;
      const url = videoPreviewUrl(item);
      if (url) previews.push({ id, url });
    }
    sendJson(res, 200, { previews });
  };
}

function itemHandler(cfg, db) {
  return (req, res, params) => {
    if (!requireAdmin(cfg, req, res)) return;
    const item = db.get(params.id);
    if (!item) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const q = parseQuery(req.url);
    let folder;
    try { folder = resolveFolder(db, q.folder); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const nb = db.neighbors(item.id, { ...q, folderPath: folder?.path || '' });
    sendJson(res, 200, {
      item: publicItem(db.present(item, { history: true }), cfg, true),
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
    const body = await readJsonBody(req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        (body.folder !== undefined && typeof body.folder !== 'string')) {
      return sendJson(res, 400, { error: 'Choose a folder from the folder menu' });
    }
    try {
      const folder = resolveFolder(db, body.folder);
      const result = scanner.startScan({ force: body.force === true, folder: folder?.path ?? null });
      if (!result.started && !result.queued) return sendJson(res, 409, { ...result, error: result.reason === 'editing' ? 'A media edit is still running.' : 'The server is stopping.' });
      return sendJson(res, 202, result);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message });
    }
  };
}

function scanControlHandler(cfg, scanner) {
  return async (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    try {
      const body = await readJsonBody(req, 4096);
      if (typeof body?.paused !== 'boolean')
        return sendJson(res, 400, { error: 'Choose whether to pause or resume indexing.' });
      const pauseState = scanner.setScanPaused(body.paused);
      sendJson(res, 200, { pauseState });
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
  };
}

function healthHandler(cfg) {
  return (req, res) => {
    sendJson(res, 200, { ok: true, role: cfg.role });
  };
}

function libraryStatusHandler(cfg, scanner) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const { logs, recentActivities, progress, unsupported, failed, walkErrors, ...summary } = scanner.status();
    const details = new URL(req.url, 'http://localhost').searchParams.get('details') === '1';
    if (details) return sendJson(res, 200, { ...summary, progress, logs, recentActivities });
    if (!progress) return sendJson(res, 200, { ...summary, progress });
    const { recentActivities: scanActivities, ...currentProgress } = progress;
    sendJson(res, 200, { ...summary, progress: currentProgress });
  };
}

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
    const items = db.store.sql.prepare(`SELECT c.filename,c.creator,c.album,c.type,c.width,c.height,
      c.date_key AS date, json_extract(c.data,'$.size') AS bytes
      FROM catalog c WHERE ${db.dashboardMediaFilter.sql}
      ORDER BY c.creator,c.filename,c.id LIMIT ? OFFSET ?`).all(...db.dashboardMediaFilter.values, limit + 1, offset);
    sendJson(res, 200, { items: items.slice(0, limit), nextOffset: items.length > limit ? offset + limit : null });
  };
}

function dashboardHandler(cfg, db, scanner) {
  let snapshot;
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    if (snapshot?.revision !== db.revision) snapshot = buildSummary();
    sendJson(res, 200, { ...snapshot.data, lastScan: scanner.lastScan, history: scanner.history,
      unsupported: scanner.unsupported.slice(0, 160), failed: scanner.failed.slice(0, 50), walkErrors: scanner.walkErrors.slice(0, 50),
      issueCount: scanner.stats.unsupportedCount + scanner.stats.failedCount + scanner.stats.unreadableDirectoryCount
    });
  };
  function buildSummary() {
    const creators = new Map(), formats = new Map(), resolutions = new Map();
    const totals = { photos: 0, videos: 0, bytes: 0, indexed: 0 };
    for (const item of db.visibleItems()) {
      totals.indexed++;
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
    return { revision: db.revision, data: {
      totals,
      creators: [...creators.values()].sort((a, b) => b.photos + b.videos - a.photos - a.videos).slice(0, 25),
      formats: ranked(formats), resolutions: ranked(resolutions)
    } };
  }
}

function diagnosticsHandlers(cfg, db, diagnostics, scanner, playback) {
  function repairKind(issue, item) {
    if (issue?.code === 'SCAN_FILE_FAILED' && scanner.canRepair(issue.path)) return 'scan';
    if (issue?.code === 'BACKGROUND_TASK_FAILED' && issue.stage === 'playback' &&
        item?.type === 'video' && item.availability === 'available' &&
        scanner.canRepair(issue.path)) return 'playback';
    return null;
  }
  function repairDetails(issue, kind, item) {
    const status = kind && diagnostics.repairStatus(issue.id);
    if (!status) return null;
    const playbackUrl = kind === 'playback' && status.state === 'completed'
      ? '/api/items/' + encodeURIComponent(item.id) + '/playback/video' : undefined;
    return { ...status, playbackUrl };
  }
  function repairIssue(res, id) {
    const issue = /^[a-f0-9]{16}$/.test(id) ? diagnostics.issue(id) : null;
    const item = issue?.path ? db.findByRelPath(issue.path) : null;
    const kind = repairKind(issue, item);
    if (!kind) {
      sendJson(res, 404, { error: 'This notification has no repairable source.' });
      return null;
    }
    return { issue, item, kind };
  }
  function serializeIssue(issue) {
    const item = issue.path ? db.findByRelPath(issue.path) : null;
    const kind = repairKind(issue, item);
    return { ...issue, itemId: item?.id || null, repairable: Boolean(kind), repairKind: kind,
      repair: repairDetails(issue, kind, item) };
  }
  return {
    get(req, res) {
      if (!requireAdmin(cfg, req, res)) return;
      const q = new URL(req.url, 'http://localhost').searchParams;
      const offset = Math.min(10000000, Math.max(0, Number.parseInt(q.get('offset') || '0', 10) || 0));
      const limit = Math.min(60, Math.max(1, Number.parseInt(q.get('limit') || '40', 10) || 40));
      if (q.get('view') === 'repairs' && q.has('id')) {
        const id = q.get('id');
        const issue = /^[a-f0-9]{16}$/.test(id) ? diagnostics.repairIssue(id) : null;
        if (!issue) return sendJson(res, 404, { error: 'Media issue unavailable.' });
        return sendJson(res, 200, serializeIssue(issue));
      }
      const page = q.get('view') === 'repairs'
        ? diagnostics.repairPage({ offset, limit })
        : diagnostics.page({ offset, limit, errorsOnly: q.get('level') === 'error', generalOnly: q.get('view') === 'general' });
      sendJson(res, 200, { ...page, canExportRecovery: cfg.allowOriginalDownload, issues: page.issues.map(serializeIssue) });
    },
    recoveryList(req, res) {
      if (!requireAdmin(cfg, req, res)) return;
      if (!cfg.allowOriginalDownload)
        return sendJson(res, 403, { error: 'Original downloads are disabled on this server.' });
      const items = [];
      const seen = new Set();
      for (const issue of diagnostics.recoveryCandidates()) {
        if (seen.has(issue.path)) continue;
        const item = issue.code === 'SCAN_FILE_FAILED' ? null : db.findByRelPath(issue.path);
        if (!repairKind(issue, item)) continue;
        seen.add(issue.path);
        items.push({ path: issue.path, file: recoveryFileName(issue), url: recoveryUrl(issue.id) });
      }
      res.setHeader('Content-Disposition', 'attachment; filename="vidstream-recovery.json"');
      sendJson(res, 200, { version: 1, items });
    },
    async recoverySource(req, res, { id }) {
      if (!requireAdmin(cfg, req, res)) return;
      if (!cfg.allowOriginalDownload)
        return sendJson(res, 403, { error: 'Original downloads are disabled on this server.' });
      const target = repairIssue(res, id);
      if (!target) return;
      let source;
      try { source = await resolveMediaSource(cfg.mediaDir, target.issue.path); }
      catch { return sendJson(res, 404, { error: 'The original could not be read. Check its mount and permissions.' }); }
      return serveFile(req, res, source, { downloadName: recoveryFileName(target.issue) });
    },
    read(req, res) {
      if (!requireAdmin(cfg, req, res)) return;
      const generalOnly = new URL(req.url, 'http://localhost').searchParams.get('view') === 'general';
      sendJson(res, 200, { marked: diagnostics.markRead(generalOnly) });
    },
    repairStatus(req, res, { id }) {
      if (!requireAdmin(cfg, req, res)) return;
      const target = repairIssue(res, id);
      if (target) sendJson(res, 200, repairDetails(target.issue, target.kind, target.item) || { state: 'idle' });
    },
    repair(req, res, { id }) {
      if (!requireAdmin(cfg, req, res)) return;
      const target = repairIssue(res, id);
      if (!target) return;
      const { issue, item, kind } = target;
      const current = diagnostics.repairStatus(id);
      if (current?.state === 'running') return sendJson(res, 202, current);
      const importRepair = kind === 'scan';
      if (scanner.stopping || (importRepair && (scanner.scanning || scanner.editing)))
        return sendJson(res, 409, { error: 'Wait for the current scan or library operation to finish.' });
      const message = importRepair ? 'Checking the source and rebuilding VidStream copies.'
        : 'Preparing a compatible playback copy.';
      diagnostics.setRepair(id, 'running', message);
      const work = importRepair ? scanner.repair(issue.path) : playback.retry(item);
      work.then(
        () => diagnostics.setRepair(id, 'completed', importRepair
          ? 'VidStream copies rebuilt. Original file unchanged.'
          : 'Compatible playback copy is ready. Original file unchanged.'),
        error => diagnostics.setRepair(id, scanner.stopping ? 'interrupted' : 'failed',
          scanner.stopping ? 'The server stopped before repair completed. Try again when the library is idle.'
            : (importRepair ? 'Could not rebuild VidStream copies. ' : 'Could not prepare compatible playback. ') +
              String(error.message).split(cfg.mediaDir + '/').join('').slice(0, 400) + ' Original file unchanged.')
      ).catch(error => console.error('[stream] Could not save repair status:', error.message));
      sendJson(res, 202, { state: 'running', message });
    },
  };
}

function recoveryUrl(id) { return '/api/notifications/' + id + '/source'; }

function recoveryFileName(issue) {
  return issue.id + '-' + posix.basename(issue.path).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
}

function requireAdmin(cfg, req, res) {
  if (isAdmin(req, cfg)) return true;
  sendJson(res, 403, { error: 'Admin sign-in required' });
  return false;
}

function duplicatesHandler(cfg, db) {
  return (req, res) => {
    if (!requireAdmin(cfg, req, res)) return;
    const groups = db.duplicateGroups({ threshold: cfg.duplicateThreshold });
    sendJson(res, 200, {
      groups: groups.map((g) => g.map((i) => publicItem(i, cfg, true))),
    });
  };
}

module.exports = {
  itemsHandler,
  readyPreviewsHandler,
  itemHandler,
  rescanHandler,
  scanControlHandler,
  healthHandler,
  libraryStatusHandler,
  duplicatesHandler,
  dashboardHandler,
  dashboardFilesHandler,
  diagnosticsHandlers,
  aiStatusHandler, aiUpdateHandler, aiInstallHandler,
  sendJson,
  parseQuery,
};
