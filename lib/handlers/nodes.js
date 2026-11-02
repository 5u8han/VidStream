'use strict';

const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function nodesHandlers(cfg, manager) {
  function admin(req, res) {
    if (isAdmin(req, cfg)) return true;
    json(res, 403, { error: 'Owner sign-in is required to manage connected libraries.' }); return false;
  }
  function mutation(req, res) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 415, { error: 'Use a same-origin JSON request.' }); return false;
    }
    const origin = req.headers.origin;
    if (origin && origin !== (req.headers['x-forwarded-proto'] === 'https' ? 'https://' : 'http://') + req.headers.host) {
      json(res, 403, { error: 'Use a same-origin JSON request.' }); return false;
    }
    return true;
  }
  function action(fn) {
    return async (req, res) => {
      if (!admin(req, res) || !mutation(req, res)) return;
      try { json(res, 200, await fn(await readJsonBody(req, 4096))); }
      catch (error) { json(res, error.status || 400, { error: error.message }); }
    };
  }
  return {
    info: (_req, res) => cfg.setupRequired ? json(res, 503, { error: 'Complete owner setup first.' }) : json(res, 200, manager.descriptor()),
    list: (req, res) => { if (admin(req, res)) json(res, 200, manager.status()); },
    settings: action(body => manager.updateSettings(body)),
    probe: action(async body => ({ peer: await manager.probe(body.url) })),
    add: action(body => manager.add(body)),
    remove: action(body => manager.remove(body.id)),
    refresh: (req, res) => {
      if (!admin(req, res) || !mutation(req, res)) return;
      void manager.refresh().catch(() => {});
      json(res, 202, manager.status());
    },
  };
}

module.exports = { nodesHandlers };
