'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');

const MAX_ITEMS = 200;

function cleanupDir(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

function downloadZipHandler(cfg, db) {
  return async (req, res) => {
    if (!cfg.allowOriginalDownload) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Downloads are disabled on this stream');
      return;
    }

    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_ITEMS) : [];
    if (ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No items selected');
      return;
    }

    const admin = isAdmin(req, cfg);
    const seenNames = new Map(); // dedupe filenames (e.g. same IMG_001.jpg from two albums)
    const items = [];
    for (const id of ids) {
      const item = db.get(id);
      if (!item) continue;
      if (item.guest !== true && !admin) continue; // silently skip, not an error for the whole batch
      let name = item.filename;
      if (seenNames.has(name)) {
        const n = seenNames.get(name) + 1;
        seenNames.set(name, n);
        const ext = path.extname(name);
        name = `${path.basename(name, ext)}-${n}${ext}`;
      } else {
        seenNames.set(name, 0);
      }
      items.push({ full: path.join(cfg.mediaDir, item.relPath), name });
    }

    if (items.length === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('None of the selected items are available');
      return;
    }

    // zip -j strips directories but can't rename entries, and just
    // using on-disk basenames risks silently dropping files when two
    // selected items share a filename (common with camera-generated
    // names like IMG_001.jpg across different albums). A staging dir
    // of symlinks under the deduped names sidesteps that correctly --
    // zip follows symlinks by default, storing real file content.
    let stagingDir;
    try {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-zip-'));
      for (const it of items) {
        fs.symlinkSync(it.full, path.join(stagingDir, it.name));
      }
    } catch (err) {
      if (stagingDir) cleanupDir(stagingDir);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not prepare download');
      return;
    }

    const zipName = items.length === 1
      ? items[0].name.replace(/\.[^.]+$/, '') + '.zip'
      : `stream-${new Date().toISOString().slice(0, 10)}.zip`;

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-cache',
    });

    const child = spawn('zip', ['-j', '-r', '-', '.'], { cwd: stagingDir });
    child.stdout.pipe(res);
    child.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    child.on('close', () => cleanupDir(stagingDir));
    req.on('close', () => { if (!child.killed) child.kill(); });
  };
}

module.exports = { downloadZipHandler };
