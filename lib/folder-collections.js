'use strict';
const crypto = require('node:crypto');

const SETTING = 'folderCollections';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function normalizePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\x00-\x1f\x7f]/.test(value))
    throw Error('Use a folder path relative to the mounted media folder, with / between folders');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value))
    throw Error('Use a relative folder path, not a machine address');
  if (value === '' || value === '.') return '';
  const normalized = value.replace(/\/+$/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw Error('Folder paths cannot contain empty, . or .. segments');
  return normalized;
}

function normalizeFolders(value) {
  if (!Array.isArray(value) || value.length > 64) throw Error('Choose up to 64 folder collections');
  const ids = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('Invalid folder collection');
    const id = entry.id === undefined || entry.id === '' ? crypto.randomUUID() : entry.id;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) throw Error('Folder collection IDs must be unique');
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Give each collection a name of 1–80 characters');
    ids.add(id);
    return { id, name, path: normalizePath(entry.path) };
  });
}

function folders(db) {
  if (Array.isArray(db.mediaFolders)) {
    return db.mediaFolders.map((name) => ({
      id: crypto.createHash('sha256').update(name).digest('hex'),
      name,
      path: name,
    }));
  }
  return db.store.setting(SETTING, []);
}

function folderRange(folderPath, column = 'c.rel_path') {
  return folderPath ? { sql: column + '>=? AND ' + column + '<?', values: [folderPath + '/', folderPath + '0'] }
    : { sql: '1=1', values: [] };
}

function resolveFolder(db, id) {
  if (!id) return null;
  if (!ID.test(id)) throw Object.assign(Error('Folder collection not found'), { status: 404 });
  const folder = folders(db).find((entry) => entry.id === id);
  if (!folder)
    throw Object.assign(Error('Folder collection not found'), { status: 404 });
  return folder;
}

function galleryScope(db, id, subfolder) {
  const folder = resolveFolder(db, id);
  const relative = normalizePath(subfolder || '');
  return { folder, folderPath: [folder?.path, relative].filter(Boolean).join('/') };
}

module.exports = { SETTING, normalizePath, normalizeFolders, folders, folderRange, resolveFolder, galleryScope };
