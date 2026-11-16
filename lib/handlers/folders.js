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
        canAddFolders: cfg.role !== 'node',
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
        if (cfg.role === 'node') {
          const current = new Set(folders(db).map(folder => folder.id));
          if (entries.some(folder => !current.has(folder.id)))
            return send(res, 403, { error: 'Switch this machine to Server in Settings → Nodes to add a folder shortcut.' });
        }
        db.store.setSetting(SETTING, entries);
        send(res, 200, { folders: entries, isAdmin: true, canAddFolders: cfg.role !== 'node' });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
    }
  };
}

module.exports = { folderCollectionsHandlers };
