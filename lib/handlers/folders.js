'use strict';
const { isAdmin, hasSameOrigin } = require('../auth');
const { readJsonBody } = require('../body');
const { SETTING, normalizeFolders, folders } = require('../folder-collections');

function send(res, status, body) {
  const value = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(value) });
  res.end(value);
}

function folderCollectionsHandlers(cfg, db) {
  return {
    get(req, res) {
      if (!isAdmin(req, cfg)) return send(res, 403, { error: 'Owner sign-in required' });
      const entries = folders(db);
      const managedByMounts = Array.isArray(db.mediaFolders);
      send(res, 200, {
        folders: entries,
        isAdmin: true,
        managedByMounts,
        ...(managedByMounts ? { primaryFolderId: entries[0]?.id ?? null } : {}),
      });
    },
    async update(req, res) {
      if (!isAdmin(req, cfg)) return send(res, 403, { error: 'Owner sign-in required' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['sec-fetch-site'] === 'cross-site')
        return send(res, 415, { error: 'Use a same-origin JSON request' });
      if (!hasSameOrigin(req, cfg))
        return send(res, 403, { error: 'Use a same-origin JSON request' });
      if (Array.isArray(db.mediaFolders))
        return send(res, 409, { error: 'Change the media mounts in Docker Compose and recreate the container to update the folder list.' });
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
