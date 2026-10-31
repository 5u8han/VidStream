'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');
const { serveFile } = require('../serve-file');
const { optionsFor } = require('../enhancement-queue');
const { estimate, policyFor } = require('../media-policy');
const { publicItem } = require('../serialize');
const { verified } = require('../durable-files');
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function workbenchHandlers(
  cfg,
  db,
  { queue, variants, maintenance, coordinator, playback, scanner }
) {
  function guard(req, res, mutation = false) {
    if (!isAdmin(req, cfg)) {
      json(res, 403, { error: 'Admin access required' });
      return false;
    }
    if (
      mutation &&
      (!(req.headers['content-type'] || '').startsWith('application/json') ||
        req.headers['sec-fetch-site'] === 'cross-site')
    ) {
      json(res, 415, { error: 'Same-origin JSON required' });
      return false;
    }
    return true;
  }
  function route(fn, mutation = false) {
    return async (req, res, params = {}) => {
      if (!guard(req, res, mutation)) return;
      try {
        await fn(req, res, params);
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    };
  }
  function item(id) {
    const value = db.get(id);
    if (!value) throw Error('Media not found');
    return value;
  }
  function refreshDerivatives() {
    // Publication commits before any rebuild begins. A failed rebuild leaves
    // the published source and recovery journal available for the next rescan.
    if (typeof scanner.scan === 'function')
      setImmediate(() =>
        scanner
          .scan()
          .catch((error) => console.error('[stream] Reconcile after publication:', error.message))
      );
  }
  return {
    estimate: route(async (req, res, p) => {
      const i = item(p.id),
        body = await readJsonBody(req),
        options = optionsFor(body, i);
      const result = estimate(i, options),
        sample = db.store
          .jobs()
          .find(
            (j) =>
              j.itemId === i.id &&
              j.options.preview &&
              j.state === 'completed' &&
              j.options.smoothing === options.smoothing &&
              j.options.upscale === options.upscale
          );
      if (sample) {
        const elapsed = (Date.parse(sample.completedAt) - Date.parse(sample.createdAt)) / 1000;
        result.estimatedSeconds = (elapsed / sample.duration) * result.seconds;
      }
      json(res, 200, { ...result, policy: policyFor(i) });
    }, true),
    status: route(async (req, res) =>
      json(res, 200, {
        work: coordinator.status(),
        scan: { running: scanner.scanning, stats: scanner.stats, last: scanner.lastScan },
        workerError: queue.lastError
      })
    ),
    preset: route(async (req, res) => {
      const body = await readJsonBody(req);
      json(res, 200, coordinator.setPreset(body.preset));
    }, true),
    variants: route(async (req, res, p) =>
      json(res, 200, {
        variants: db.store.variants(item(p.id)),
        item: publicItem(item(p.id), cfg, true)
      })
    ),
    variant: route(async (req, res, p) => {
      const i = item(p.id),
        body = await readJsonBody(req);
      let result = {};
      if (body.action === 'activate') await variants.activate(i, body.id);
      else if (body.action === 'publish') {
        if (body.confirm !== true) throw Error('Confirm publishing and archiving the original');
        result = await coordinator.run('publish', i.filename, () => variants.publish(i, body.id), {
          heavy: true,
          priority: 20
        });
        refreshDerivatives();
      } else if (body.action === 'restore') {
        if (body.confirm !== true) throw Error('Confirm restoring the archived original');
        result = await coordinator.run('restore', i.filename, () => variants.restore(i), {
          heavy: true,
          priority: 20
        });
        refreshDerivatives();
      } else throw Error('Unknown version action');
      json(res, 200, { ...result, item: publicItem(i, cfg, true) });
    }, true),
    relink: route(async (req, res, p) => {
      const i = item(p.id),
        body = await readJsonBody(req);
      if (scanner.scanning || scanner.editing)
        throw Error('Wait for scanning/editing to finish before relinking');
      scanner.editing = true;
      try {
        if (typeof body.path !== 'string' || path.isAbsolute(body.path) || body.path.includes('\\'))
          throw Error('Choose a relative library path using forward slashes');
        const relative = path.normalize(body.path),
          root = fs.realpathSync(cfg.mediaDir),
          resolved = fs.realpathSync(path.resolve(root, relative));
        if (!resolved.startsWith(root + path.sep))
          throw Error('Path must remain inside the library');
        if (!fs.statSync(resolved).isFile()) throw Error('Media file not found');
        if (db.findByRelPath(relative) && db.findByRelPath(relative).id !== i.id)
          throw Error(
            'That path belongs to another media item; existing history will not be overwritten'
          );
        if (!i.sourceHash)
          throw Error(
            'This item needs a content hash before it can be safely relinked. Reconcile the library first.'
          );
        if (!(await verified(resolved, i.sourceHash)))
          throw Error(
            'The selected file differs from this item. Relinking requires identical source bytes.'
          );
        const current = path.resolve(root, i.relPath);
        if (current !== resolved && fs.existsSync(current))
          throw Error('The old file is still present; this is a separate copy, not a move');
        db.relocate(i, relative);
        i.availability = 'available';
        db.upsert(i);
        refreshDerivatives();
        json(res, 200, { item: publicItem(i, cfg, true) });
      } finally {
        scanner.editing = false;
      }
    }, true),
    storage: route(async (req, res) => json(res, 200, await maintenance.storage())),
    backup: route(async (req, res) => {
      const result = await maintenance.backup();
      json(res, 200, {
        name: result.name,
        url: '/api/maintenance/backup/' + result.name,
        note: result.note
      });
    }, true),
    backupFile: route(async (req, res, p) => {
      if (!/^library-\d+-[a-f0-9]{8}\.sqlite$/.test(p.name)) throw Error('Invalid snapshot name');
      serveFile(req, res, path.join(cfg.dataDir, 'backups', p.name), { downloadName: p.name });
    }),
    retention: route(async (req, res) => {
      const body = await readJsonBody(req);
      if (body.confirm !== true) throw Error('Confirm removing old raw activity');
      json(res, 200, maintenance.pruneActivity(body.days));
    }, true),
    recover: route(async (req, res) => {
      const body = await readJsonBody(req);
      if (body.confirm !== true) throw Error('Confirm recovering interrupted publication');
      const result = await coordinator.run(
        'recovery',
        'Recover interrupted publication',
        () => variants.recoverPending(),
        { heavy: true, priority: 5 }
      );
      if (result.recovered) refreshDerivatives();
      json(res, 200, result);
    }, true),
    playback: async (req, res, p) => {
      const i = db.get(p.id);
      if (!i || (!isAdmin(req, cfg) && !i.guest))
        return json(res, 404, { error: 'Media unavailable' });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      try {
        if (
          !(req.headers['content-type'] || '').startsWith('application/json') ||
          req.headers['sec-fetch-site'] === 'cross-site'
        )
          throw Error('Same-origin JSON required');
        json(res, 202, await playback.prepare(i));
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    },
    playbackFile: (req, res, p) => {
      const i = db.get(p.id);
      if (!i || (!isAdmin(req, cfg) && !i.guest))
        return json(res, 404, { error: 'Media unavailable' });
      serveFile(req, res, playback.file(i), { cacheForever: true });
    }
  };
}
module.exports = { workbenchHandlers };
