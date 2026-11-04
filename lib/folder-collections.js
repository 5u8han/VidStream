'use strict';
const crypto = require('node:crypto');

const SETTING = 'folderCollections';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const visibilityCache = new WeakMap();

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
  return db.store.setting(SETTING, []);
}

// A literal binary prefix range uses catalog_path without treating % or _ as
// wildcards. The upper bound replaces the final slash with its next character.
function folderRange(folderPath, column = 'c.rel_path') {
  return folderPath ? { sql: column + '>=? AND ' + column + '<?', values: [folderPath + '/', folderPath + '0'] }
    : { sql: '1=1', values: [] };
}

function visibleFolders(db, admin) {
  const entries = folders(db);
  if (admin) return entries.map((folder) => ({ ...folder }));
  const key = JSON.stringify([db.revision, db.store.catalogRevision || 0, entries]);
  const cached = visibilityCache.get(db);
  if (cached?.key === key) return cached.folders;
  const result = entries.filter((folder) => {
    const range = folderRange(folder.path);
    return Boolean(db.store.sql.prepare('SELECT 1 FROM catalog c WHERE c.guest=1 AND ' + range.sql + ' LIMIT 1').get(...range.values));
  }).map((folder) => ({ id: folder.id, name: folder.name }));
  visibilityCache.set(db, { key, folders: result });
  return result;
}

function resolveFolder(db, id, admin) {
  if (!id) return null;
  if (!ID.test(id)) throw Object.assign(Error('Folder collection not found'), { status: 404 });
  const folder = folders(db).find((entry) => entry.id === id);
  if (!folder || (!admin && !visibleFolders(db, false).some((entry) => entry.id === id)))
    throw Object.assign(Error('Folder collection not found'), { status: 404 });
  return folder;
}

module.exports = { SETTING, normalizePath, normalizeFolders, folders, folderRange, visibleFolders, resolveFolder };
