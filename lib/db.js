'use strict';
const fs = require('fs');
const path = require('path');
const { LibraryStore } = require('./library-store');
const { hammingDistance } = require('./vision-hash');
const catalog = require('./catalog');

function seededHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function creatorOf(item) {
  return item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)');
}

class Db {
  constructor(
    filePath,
    dataDir = path.join(path.dirname(filePath), 'library-data'),
    { mediaFolders = null } = {}
  ) {
    const validFolderNames = Array.isArray(mediaFolders) && mediaFolders.every((name) =>
      typeof name === 'string' && name && name !== '.' && name !== '..' && path.basename(name) === name && !name.includes('\x00'));
    if (mediaFolders !== null && !validFolderNames) {
      throw Error('Mounted media folders must be immediate directory names');
    }
    this.mediaFolders = mediaFolders === null ? null : Object.freeze([...new Set(mediaFolders)]);
    const scope = catalog.mediaRange(this.mediaFolders);
    this.dashboardMediaFilter = { sql: '(' + scope.sql + ') AND ' + catalog.VISIBLE_MEDIA_FILTER, values: scope.values };
    this._mediaFolderNames = this.mediaFolders === null ? null : new Set(this.mediaFolders);
    this.store = new LibraryStore(dataDir);
    this.filePath = filePath;
    this.revision = 0;
    this.items = new Map();
    this._findCatalogPath = this.store.sql.prepare('SELECT id FROM catalog WHERE rel_path=?');
    this._findCatalogIdentity = this.store.sql.prepare(`SELECT id FROM catalog WHERE media_id=COALESCE(
      (SELECT media_id FROM catalog_aliases WHERE alias=?), ?)`);
    this._findReservedIdentity = this.store.sql.prepare(`SELECT media_id FROM catalog WHERE id=?
      UNION ALL SELECT media_id FROM catalog_aliases WHERE alias=? LIMIT 1`);
    this._saveTimer = null;
    this._load();
    for (const item of this.items.values()) {
      const identity = item.mediaId,
        version = item.sourceVersion;
      this.store.hydrate(item, { details: false });
      item.sourceVersion = catalog.sourceVersion(item);
      if (item.mediaId !== identity || item.sourceVersion !== version) this.store.saveCatalog(item);
    }
  }

  _load() {
    if (!this.store.setting('catalogImported', false)) {
      let arr = [];
      if (fs.existsSync(this.filePath)) {
        arr = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (!Array.isArray(arr))
          throw Error('Legacy media catalog is invalid; restore its backup before continuing');
        const backup = path.join(path.dirname(this.store.file), 'migration-backups');
        fs.mkdirSync(backup, { recursive: true });
        fs.copyFileSync(
          this.filePath,
          path.join(backup, 'index-' + Date.now() + '-' + catalog.identity() + '.json'),
          fs.constants.COPYFILE_EXCL
        );
      }
      this.store.sql.exec('BEGIN IMMEDIATE');
      try {
        for (const item of arr) {
          this.store.hydrate(item);
          item.sourceVersion = catalog.sourceVersion(item);
          this.store.saveCatalog(item);
        }
        this.store.setSetting('catalogImported', true);
        this.store.sql.exec('COMMIT');
      } catch (error) {
        this.store.sql.exec('ROLLBACK');
        throw error;
      }
    }
    for (const item of this.store.catalogItems(this.mediaFolders)) {
      if (this.includesMediaPath(item.relPath)) this.items.set(item.id, item);
    }
  }

  _scheduleSave() {
    this._dirty = true;
  }

  _saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    for (const item of this.items.values()) this.store.saveCatalog(item);
    this._dirty = false;
    const arr = Array.from(this.items.values());
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, this.filePath);
  }

  upsert(record) {
    if (!this.includesMediaPath(record.relPath)) throw Error('Media must be inside a selected mounted folder');
    const prior = this.items.get(record.id) || this.findByRelPath(record.relPath);
    if (this.mediaFolders !== null && !this.items.has(record.id)) {
      const reserved = this._findReservedIdentity.get(record.id, record.id);
      if (reserved && reserved.media_id !== prior?.mediaId) throw Error('Media identifier is already reserved');
    }
    const previousId = prior && prior.id !== record.id ? prior.id : null;
    this.store.sql.exec('BEGIN IMMEDIATE');
    try {
      if (prior) record.mediaId = prior.mediaId;
      if (previousId) this.store.sql.prepare('DELETE FROM catalog WHERE id=?').run(previousId);
      this.store.hydrate(record, { details: false });
      record.sourceVersion = catalog.sourceVersion(record);
      this.store.saveCatalog(record);
      this.store.sql.exec('COMMIT');
    } catch (error) {
      this.store.sql.exec('ROLLBACK');
      throw error;
    }
    if (previousId) this.items.delete(previousId);
    this.items.set(record.id, record);
    this.revision++;
    this._scheduleSave();
  }

  remove(id) {
    const item = this.get(id, { includeArchived: true });
    if (!item) return;
    this.items.delete(item.id);
    this.store.sql.prepare('DELETE FROM catalog WHERE id=?').run(item.id);
    this.revision++;
    this._scheduleSave();
  }

  get(id, { includeArchived = false } = {}) {
    if (typeof id !== 'string') return null;
    const item = this.items.get(id) || this.items.get(this._findCatalogIdentity.get(id, id)?.id);
    if (!item || (!includeArchived && item.availability === 'archived')) return null;
    return item;
  }

  has(id) {
    return !!this.get(id);
  }

  reservedIds() {
    return this.store.sql
      .prepare('SELECT alias FROM catalog_aliases')
      .all()
      .map((row) => row.alias);
  }

  relocate(item, newRelPath) {
    if (typeof item === 'string') item = this.get(item);
    if (!item || !this.includesMediaPath(item.relPath)) throw Error('Media not found');
    const normalized = String(newRelPath).replace(/\\/g, '/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      normalized.split('/').some((part) => part === '..' || !part)
    )
      throw Error('Choose a relative media path');
    if (!this.includesMediaPath(normalized)) throw Error('Choose a path inside a selected mounted folder');
    const other = this.findByRelPath(normalized);
    if (other && other.mediaId !== item.mediaId)
      throw Error('The destination already belongs to another media item');
    const old = item.relPath;
    if (old === normalized) return item;
    const destinationState = this.store.read.get(normalized);
    if (destinationState)
      throw Error(
        'The destination has saved history; choose another path or relink explicitly after resolving it'
      );
    const next = {
      ...item,
      relPath: normalized,
      filename: path.basename(normalized),
      album: path.dirname(normalized) === '.' ? null : path.dirname(normalized)
    };
    next.creator = next.album ? next.album.split('/')[0] : '(Unsorted)';
    this.store.sql.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['media_state', 'events', 'activity', 'activity_totals'])
        this.store.sql.prepare('UPDATE ' + table + ' SET path=? WHERE path=?').run(normalized, old);
      this.store.saveCatalog(next);
      this.store.event.run(
        normalized,
        new Date().toISOString(),
        'relocated',
        JSON.stringify({ from: old, to: normalized })
      );
      this.store.sql.exec('COMMIT');
    } catch (error) {
      this.store.sql.exec('ROLLBACK');
      throw error;
    }
    Object.assign(item, next);
    this.store.hydrate(item);
    this.revision++;
    this._scheduleSave();
    return item;
  }

  findByRelPath(relPath) {
    if (typeof relPath !== 'string' || !this.includesMediaPath(relPath)) return null;
    const row = this._findCatalogPath.get(relPath);
    return this.items.get(row?.id) || null;
  }

  includesMediaPath(relPath) {
    if (typeof relPath !== 'string') return false;
    if (relPath.split('/').some(segment => segment === catalog.ARCHIVE_DIRECTORY || segment === catalog.PORTABLE_STORAGE_DIRECTORY)) return false;
    if (this._mediaFolderNames === null) return true;
    const separator = relPath.indexOf('/');
    return separator > 0 && this._mediaFolderNames.has(relPath.slice(0, separator));
  }

  allRelPaths() {
    return new Set(Array.from(this.items.values(), (i) => i.relPath));
  }

  effectiveDate(item) {
    return item.dateTaken || item.mtime;
  }

  filterOptions(folderPath = '') {
    const version = this.revision + ':' + (this.store.catalogRevision || 0);
    if (this._filterOptionsVersion !== version) {
      this._filterOptionsVersion = version;
      this._filterOptionsCache = new Map();
    }
    const key = folderPath;
    if (this._filterOptionsCache.has(key)) return this._filterOptionsCache.get(key);
    const range = catalog.mediaRange(this.mediaFolders, folderPath);
    const where = ' WHERE (' + range.sql + ') AND ' + catalog.VISIBLE_MEDIA_FILTER;
    const albums = this.store.sql.prepare('SELECT DISTINCT c.album AS name FROM catalog c' + where + " AND c.album IS NOT NULL AND c.album<>'' ORDER BY c.album").all(...range.values).map((row) => row.name);
    const creators = this.store.sql.prepare('SELECT DISTINCT c.creator AS name FROM catalog c' + where).all(...range.values).map((row) => row.name).sort((a, b) => a.localeCompare(b));
    const objectClasses = this.store.sql.prepare("SELECT DISTINCT o.value AS name FROM catalog c,json_each(c.data,'$.objects') o" + where + " AND json_type(c.data,'$.objects')='array' AND typeof(o.value)='text' ORDER BY o.value").all(...range.values).map((row) => row.name);
    const result = { albums, creators, objectClasses };
    if (this._filterOptionsCache.size >= 16) this._filterOptionsCache.delete(this._filterOptionsCache.keys().next().value);
    this._filterOptionsCache.set(key, result);
    return result;
  }

  albums(folderPath = '') {
    return this.filterOptions(folderPath).albums;
  }

  creators(folderPath = '') {
    return this.filterOptions(folderPath).creators;
  }

  count() {
    return this.items.size;
  }

  *visibleItems() {
    for (const item of this.items.values()) {
      if (item.availability !== 'archived') yield item;
    }
  }

  _comparator(sort, seed) {
    if (sort === 'name-asc' || sort === 'name-desc') {
      const dir = sort === 'name-asc' ? 1 : -1;
      return (a, b) => dir * a.filename.localeCompare(b.filename);
    }
    if (sort === 'creator') {
      return (a, b) =>
        creatorOf(a).localeCompare(creatorOf(b)) ||
        a.filename.localeCompare(b.filename) ||
        a.id.localeCompare(b.id);
    }
    if (sort === 'random') {
      const s = seed || '';
      return (a, b) => seededHash(a.id + s) - seededHash(b.id + s);
    }
    const dir = sort === 'asc' ? 1 : -1;
    return (a, b) => {
      const da = this.effectiveDate(a);
      const db_ = this.effectiveDate(b);
      if (da === db_) return a.id < b.id ? -1 : 1;
      return dir * (da < db_ ? -1 : 1);
    };
  }

  _filteredSorted({
    type,
    album,
    folderPath,
    creator,
    has,
    q,
    sort,
    seed,
    dateField,
    dateFrom,
    dateTo,
    resolution
  }) {
    let list = Array.from(this.visibleItems());
    if (folderPath) list = list.filter((i) => (i.relPath || '').startsWith(folderPath + '/'));
    if (type) list = list.filter((i) => i.type === type);
    if (album) list = list.filter((i) => i.album === album);
    if (creator) list = list.filter((i) => creatorOf(i) === creator);
    const field = dateField === 'imported' ? 'addedAt' : null;
    if (dateFrom || dateTo)
      list = list.filter((i) => {
        const value = field ? i[field] : this.effectiveDate(i);
        const day = value ? value.slice(0, 10) : '';
        return day && (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
      });
    if (resolution)
      list = list.filter((i) => {
        const shortEdge = Math.min(i.width || 0, i.height || 0);
        return shortEdge >= resolution;
      });
    if (['favorite', 'pinned', 'bookmarked'].includes(has))
      list = list.filter((i) => i[has] === true);
    else if (has === 'face') list = list.filter((i) => i.hasFace === true);
    else if (has === 'cat') list = list.filter((i) => i.hasCat === true);
    else if (has === 'text') list = list.filter((i) => i.hasText === true);
    else if (has) list = list.filter((i) => Array.isArray(i.objects) && i.objects.includes(has));
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (i) =>
          i.filename.toLowerCase().includes(needle) ||
          (i.album && i.album.toLowerCase().includes(needle)) ||
          (i.ocrText && i.ocrText.toLowerCase().includes(needle)) ||
          (Array.isArray(i.objects) && i.objects.some((o) => o.includes(needle)))
      );
    }
    const compare = this._comparator(sort, seed);
    if (sort === 'creator') list.sort(compare);
    else
      list.sort(
        (a, b) =>
          Number(b.pinned === true) - Number(a.pinned === true) ||
          Number(b.favorite === true) - Number(a.favorite === true) ||
          Number(b.bookmarked === true) - Number(a.bookmarked === true) ||
          compare(a, b)
      );
    return list;
  }

  objectClasses(folderPath = '') {
    return this.filterOptions(folderPath).objectClasses;
  }

  query({
    type = null,
    album = null,
    folderPath = '',
    creator = null,
    has = null,
    q = '',
    sort = 'desc',
    seed = '',
    dateField = 'created',
    dateFrom = null,
    dateTo = null,
    resolution = 0,
    cursor = null,
    includeTotal = true,
    limit = 60
  } = {}) {
    const result = this.store.catalogPage({
      type,
      album,
      folderPath,
      mediaFolders: this.mediaFolders,
      creator,
      has,
      q,
      sort,
      seed,
      dateField,
      dateFrom,
      dateTo,
      resolution,
      cursor,
      includeTotal,
      limit
    });
    return {
      items: result.ids.map((id) => this.present(this.items.get(id))).filter(Boolean),
      nextCursor: result.nextCursor,
      total: result.total
    };
  }

  present(item, { history = false } = {}) {
    if (item) {
      if (history) item.history = this.store.history(item);
      item.activity = this.store.activityStats(item);
      item.variants = this.store.variants(item);
      if (item.type === 'video') item.resumePosition = this.store.playbackPosition(item);
    }
    return item;
  }

  neighbors(
    id,
    {
      has = null,
      q = '',
      sort = 'desc',
      seed = '',
      type = null,
      album = null,
      folderPath = '',
      creator = null,
      dateField = 'created',
      dateFrom = null,
      dateTo = null,
      resolution = 0
    } = {}
  ) {
    const item = this.get(id),
      result = this.store.catalogNeighbors(item?.id || id, {
        has,
        q,
        sort,
        seed,
        type,
        album,
        folderPath,
        mediaFolders: this.mediaFolders,
        creator,
        dateField,
        dateFrom,
        dateTo,
        resolution
      });
    return {
      ...result,
      prev: this.present(this.items.get(result.prev)) || null,
      next: this.present(this.items.get(result.next)) || null
    };
  }

  duplicateGroups({ threshold = 10 } = {}) {
    const items = Array.from(this.visibleItems()).filter((i) => i.pHash);

    const assigned = new Set();
    const groups = [];
    for (let i = 0; i < items.length; i++) {
      if (assigned.has(items[i].id)) continue;
      const group = [items[i]];
      assigned.add(items[i].id);
      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(items[j].id)) continue;
        if (hammingDistance(items[i].pHash, items[j].pHash) <= threshold) {
          group.push(items[j]);
          assigned.add(items[j].id);
        }
      }
      if (group.length > 1) groups.push(group);
    }
    const dateSort = this._comparator('desc', '');
    groups.forEach((g) => g.sort(dateSort));
    groups.sort((a, b) => b.length - a.length);
    return groups;
  }
}

module.exports = { Db };
