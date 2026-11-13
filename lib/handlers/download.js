'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('node:stream');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');
const { attachmentHeader, resolveMediaSource } = require('../serve-file');

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
    const ids = Array.isArray(body?.ids) ? body.ids.slice(0, MAX_ITEMS) : [];
    if (ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No items selected');
      return;
    }

    const admin = isAdmin(req, cfg);
    const seenNames = new Set();
    const items = [];
    for (const id of ids) {
      if (res.destroyed) return;
      if (typeof id !== 'string') continue;
      const item = db.get(id);
      if (!item || (item.guest !== true && !admin)) continue;
      const full = await resolveMediaSource(cfg.mediaDir, item.relPath).catch(() => null);
      if (!full || !(await fs.promises.stat(full).catch(() => null))?.isFile()) continue;

      const filename = path.basename(full).replace(/[\\/]/g, '_');
      const ext = path.extname(filename);
      let name = filename;
      for (let n = 1; seenNames.has(name); n++) name = `${path.basename(filename, ext)}-${n}${ext}`;
      seenNames.add(name);
      items.push({ full, name });
    }

    if (res.destroyed) return;
    if (items.length === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('None of the selected items are available');
      return;
    }

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

    const child = spawn('zip', ['-j', '-', ...items.map(item => './' + item.name)], {
      cwd: stagingDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.on('spawn', () => {
      if (res.destroyed) {
        child.kill();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': attachmentHeader(zipName),
        'Cache-Control': 'private, no-store',
      });
      pipeline(child.stdout, res, error => { if (error) child.kill(); });
    });
    child.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else { res.writeHead(500); res.end('Could not prepare download'); }
    });
    child.on('close', () => cleanupDir(stagingDir));
  };
}

module.exports = { downloadZipHandler };
