'use strict';
const path = require('path');
const { resolveMediaSource, serveFile } = require('../serve-file');
const { isAdmin } = require('../auth');

function nearestSize(requested, allowed) {
  if (!allowed || allowed.length === 0) return null;
  if (!requested) return allowed[allowed.length - 1];
  let best = allowed[0];
  let bestDiff = Infinity;
  for (const w of allowed) {
    const diff = Math.abs(w - requested);
    if (diff < bestDiff) { best = w; bestDiff = diff; }
  }
  return best;
}

function mediaHandler(cfg, db) {
  return async function handle(req, res, params) {
    const item = db.get(params.id);
    if (!item || !isAdmin(req, cfg)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
      res.end('Not found');
      return;
    }

    const variant = params.variant;
    const query = new URL(req.url, 'http://x').searchParams;
    const requestedW = Number(query.get('w')) || null;

    if (variant === 'original' || (variant === 'large' && item.type === 'photo' && item.isAnimated)) {
      const full = await resolveMediaSource(cfg.mediaDir, item.relPath).catch(() => null);
      if (!full) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
        res.end('Not found');
        return;
      }
      const wantsDownload = variant === 'original' && query.get('download') === '1' && cfg.allowOriginalDownload;
      return serveFile(req, res, full, {
        noStore: true,
        downloadName: wantsDownload ? item.filename : null,
      });
    }

    if (variant === 'thumb' && item.type === 'photo') {
      const w = nearestSize(requestedW, cfg.thumbnailSizes);
      return serveFile(req, res, path.join(cfg.cacheDir, 'thumb', String(w), item.id + item.thumbExt), {
        noStore: true,
      });
    }

    if (variant === 'large' && item.type === 'photo') {
      const w = nearestSize(requestedW, cfg.largeSizes);
      return serveFile(req, res, path.join(cfg.cacheDir, 'large', String(w), item.id + item.largeExt), {
        noStore: true,
      });
    }

    if (variant === 'poster' && item.type === 'video') {
      const w = nearestSize(requestedW, cfg.posterSizes);
      return serveFile(req, res, path.join(cfg.cacheDir, 'poster', String(w), item.id + '.jpg'), {
        noStore: true,
      });
    }

    if (variant === 'preview' && item.type === 'video') {
      return serveFile(req, res, path.join(cfg.cacheDir, 'preview', item.id + '.mp4'), {
        noStore: true,
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
    res.end('Not found');
  };
}

module.exports = { mediaHandler };
