'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { mimeFor } = require('./mime');
const { ARCHIVE_DIRECTORY } = require('./catalog');

function attachmentHeader(name) {
  const value = String(name).toWellFormed().replace(/[\x00-\x1f\x7f]/g, '_');
  const fallback = value.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'download';
  const encoded = encodeURIComponent(value).replace(/['()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function resolveMediaSource(rootDir, relPath) {
  const root = await fs.promises.realpath(rootDir);
  const file = path.resolve(root, relPath);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Source is outside the library');
  }
  if (relative.split(path.sep).includes(ARCHIVE_DIRECTORY)) throw new Error('Source is archived');
  const source = await fs.promises.realpath(file);
  if (path.relative(file, source)) throw new Error('Source no longer matches its indexed path');
  return source;
}

async function serveFile(req, res, filePath, { noStore = false, downloadName = null } = {}) {
  let handle;
  try {
    const { O_RDONLY, O_NONBLOCK = 0, O_NOFOLLOW = 0 } = fs.constants;
    handle = await fs.promises.open(filePath, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    const stat = await handle.stat();
    if (res.destroyed) return;
    if (!stat.isFile()) throw new Error('Not a regular file');

    const headers = {
      'Content-Type': mimeFor(path.extname(filePath)),
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': noStore || downloadName ? 'private, no-store' : 'no-cache',
    };
    if (downloadName) headers['Content-Disposition'] = attachmentHeader(downloadName);

    const ifModifiedSince = req.headers['if-modified-since'];
    if (!noStore && !downloadName && ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let bounds;
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - (Number(range[2]) || 0));
      const end = Math.min(range[1] && range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
      if (!stat.size || start >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      bounds = { start, end };
    }

    headers['Content-Length'] = bounds ? bounds.end - bounds.start + 1 : stat.size;
    res.writeHead(bounds ? 206 : 200, headers);
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream(bounds), res);
  } catch {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { attachmentHeader, resolveMediaSource, serveFile };
