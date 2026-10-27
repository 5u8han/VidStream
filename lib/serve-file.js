'use strict';
const fs = require('fs');
const path = require('path');
const { mimeFor } = require('./mime');

// Serves a file from disk, honoring Range requests (206 Partial
// Content) so <video> scrubbing/seeking works. Derivatives are cached
// privately in the browser, not in shared CDN caches.
function serveFile(req, res, filePath, { cacheForever = false, downloadName = null } = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const headers = {
      'Content-Type': mimeFor(ext),
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (cacheForever) {
      headers['Cache-Control'] = 'private, max-age=86400';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    if (downloadName) {
      headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/"/g, '')}"`;
    }

    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        if (stat.size === 0) {
          res.writeHead(416, { 'Content-Range': 'bytes */0' });
          res.end();
          return;
        }
        // RFC 7233 suffix range (-500) and open-ended range (500-).
        let start = match[1] ? parseInt(match[1], 10) : Math.max(0, stat.size - (parseInt(match[2], 10) || 0));
        let end = match[1] && match[2] ? parseInt(match[2], 10) : stat.size - 1;
        end = Math.min(end, stat.size - 1);
        if (start >= stat.size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { serveFile };
