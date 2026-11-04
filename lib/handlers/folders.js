'use strict';
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');
const { SETTING, normalizeFolders, visibleFolders } = require('../folder-collections');

function send(res, status, body) {
  const value = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(value) });
  res.end(value);
}

function folderCollectionsHandlers(cfg, db) {
  return {
    get(req, res) {
      const admin = isAdmin(req, cfg);
      send(res, 200, { folders: visibleFolders(db, admin), isAdmin: admin });
    },
    async update(req, res) {
      if (!isAdmin(req, cfg)) return send(res, 403, { error: 'Owner sign-in required' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['sec-fetch-site'] === 'cross-site')
        return send(res, 415, { error: 'Use a same-origin JSON request' });
      if (req.headers.origin && req.headers.origin !== (req.headers['x-forwarded-proto'] === 'https' ? 'https://' : 'http://') + req.headers.host)
        return send(res, 403, { error: 'Use a same-origin JSON request' });
      try {
        const body = await readJsonBody(req, 128 * 1024);
        const entries = normalizeFolders(body.folders);
        db.store.setSetting(SETTING, entries);
        send(res, 200, { folders: entries, isAdmin: true });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
    }
  };
}

module.exports = { folderCollectionsHandlers };
