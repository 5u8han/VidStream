'use strict';
const path = require('path');
const { serveFile } = require('../serve-file');
const { isAdmin } = require('../auth');

function nearestSize(requested, allowed) {
  if (!allowed || allowed.length === 0) return null;
  if (!requested) return allowed[allowed.length - 1]; // default: best quality
  let best = allowed[0];
  let bestDiff = Infinity;
  for (const w of allowed) {
    const diff = Math.abs(w - requested);
    if (diff < bestDiff) { best = w; bestDiff = diff; }
  }
  return best;
}

function mediaHandler(cfg, db) {
  return function handle(req, res, params) {
    const item = db.get(params.id);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (item.guest !== true && !isAdmin(req, cfg)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const variant = params.variant;
    const query = new URL(req.url, 'http://x').searchParams;
    const requestedW = Number(query.get('w')) || null;

    if (variant === 'original') {
      // Served regardless of allowOriginalDownload, since full-quality
      // <video> playback in the lightbox streams from this endpoint too.
      // The config flag only controls the Download button + whether we
      // set Content-Disposition when it's explicitly requested.
      const full = path.join(cfg.mediaDir, item.relPath);
      const wantsDownload = query.get('download') === '1' && cfg.allowOriginalDownload;
      serveFile(req, res, full, {
        cacheForever: false,
        downloadName: wantsDownload ? item.filename : null,
      });
      return;
    }

    if (variant === 'thumb' && item.type === 'photo') {
      const w = nearestSize(requestedW, cfg.thumbnailSizes);
      serveFile(req, res, path.join(cfg.cacheDir, 'thumb', String(w), item.id + item.thumbExt), {
        cacheForever: true,
      });
      return;
    }

    if (variant === 'large' && item.type === 'photo') {
      if (item.isAnimated) {
        serveFile(req, res, path.join(cfg.mediaDir, item.relPath), { cacheForever: false });
        return;
      }
      const w = nearestSize(requestedW, cfg.largeSizes);
      serveFile(req, res, path.join(cfg.cacheDir, 'large', String(w), item.id + item.largeExt), {
        cacheForever: true,
      });
      return;
    }

    if (variant === 'poster' && item.type === 'video') {
      const w = nearestSize(requestedW, cfg.posterSizes);
      serveFile(req, res, path.join(cfg.cacheDir, 'poster', String(w), item.id + '.jpg'), {
        cacheForever: true,
      });
      return;
    }

    if (variant === 'preview' && item.type === 'video') {
      serveFile(req, res, path.join(cfg.cacheDir, 'preview', item.id + '.mp4'), {
        cacheForever: true,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

module.exports = { mediaHandler };
