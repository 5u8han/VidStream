'use strict';
const fs = require('fs');
const path = require('path');
const { LibraryStore } = require('./library-store');
const { hammingDistance } = require('./vision-hash');
const catalog = require('./catalog');
const { folderRange } = require('./folder-collections');

// Deterministic per-seed hash so "random" sort is stable across pages
// for a given seed (the client picks one seed per shuffle and reuses
// it for every subsequent page request).
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
  constructor(filePath, dataDir = path.join(path.dirname(filePath), 'library-data')) {
    this.store = new LibraryStore(dataDir);
    this.filePath = filePath;
    this.revision = 0;
    this.items = new Map(); // id -> record
    this._saveTimer = null;
    this._load();
    for (const item of this.items.values()) {
      const identity = item.mediaId,
        version = item.sourceVersion;
      this.store.hydrate(item);
      item.sourceVersion = catalog.sourceVersion(item);
      // Reopening a catalog should not fsync one unchanged row per item.
      // Imports already commit all rows together; only repair missing identity
      // or version fields here, keeping runtime history/activity out of JSON.
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
    for (const item of this.store.catalogItems()) this.items.set(item.id, item);
  }

  // Debounced so a burst of scanner writes (processing 200 photos)
  // doesn't hit disk 200 times.
  _scheduleSave() {
    // Changes already commit to SQLite synchronously. Do not repeatedly rewrite
    // the entire JSON index during imports; explicit exports remain available.
    this._dirty = true;
  }

  _saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    for (const item of this.items.values()) this.store.saveCatalog(item);
    this._dirty = false;
    // SQLite is authoritative. This JSON export is retained only as a portable
    // compatibility snapshot; deleting it never deletes the durable catalog.
    const arr = Array.from(this.items.values());
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, this.filePath);
  }

  upsert(record) {
    const prior = this.items.get(record.id) || this.findByRelPath(record.relPath);
    if (prior) {
      record.mediaId = prior.mediaId;
      if (prior.id !== record.id) {
        this.items.delete(prior.id);
        this.store.sql.prepare('DELETE FROM catalog WHERE id=?').run(prior.id);
      }
    }
    this.store.hydrate(record);
    record.sourceVersion = catalog.sourceVersion(record);
    this.store.saveCatalog(record);
    this.items.set(record.id, record);
    this.revision++;
    this._scheduleSave();
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return;
    this.items.delete(item.id);
    this.store.sql.prepare('DELETE FROM catalog WHERE id=?').run(item.id);
    this.revision++;
    this._scheduleSave();
  }

  get(id) {
    if (this.items.has(id)) return this.items.get(id);
    const alias = this.store.sql
      .prepare('SELECT media_id FROM catalog_aliases WHERE alias=?')
      .get(id);
    return (
      Array.from(this.items.values()).find((item) => item.mediaId === (alias?.media_id || id)) ||
      null
    );
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
    if (!item) throw Error('Media not found');
    const normalized = String(newRelPath).replace(/\\/g, '/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      normalized.split('/').some((part) => part === '..' || !part)
    )
      throw Error('Choose a relative media path');
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

  // Locations remain lookup keys for discovery; mediaId is the permanent
  // identity and relocate moves the associated state transactionally.
  findByRelPath(relPath) {
    for (const item of this.items.values()) {
      if (item.relPath === relPath) return item;
    }
    return null;
  }

  allRelPaths() {
    return new Set(Array.from(this.items.values(), (i) => i.relPath));
  }

  effectiveDate(item) {
    return item.dateTaken || item.mtime;
  }

  filterOptions(guestOnly = false, folderPath = '') {
    const version = this.revision + ':' + (this.store.catalogRevision || 0);
    if (this._filterOptionsVersion !== version) {
      this._filterOptionsVersion = version;
      this._filterOptionsCache = new Map();
    }
    const key = JSON.stringify([guestOnly, folderPath]);
    if (this._filterOptionsCache.has(key)) return this._filterOptionsCache.get(key);
    const range = folderRange(folderPath);
    const where = ' WHERE ' + range.sql + (guestOnly ? ' AND c.guest=1' : '');
    const albums = this.store.sql.prepare('SELECT DISTINCT c.album AS name FROM catalog c' + where + " AND c.album IS NOT NULL AND c.album<>'' ORDER BY c.album").all(...range.values).map((row) => row.name);
    const creators = this.store.sql.prepare('SELECT DISTINCT c.creator AS name FROM catalog c' + where).all(...range.values).map((row) => row.name).sort((a, b) => a.localeCompare(b));
    const objectClasses = this.store.sql.prepare("SELECT DISTINCT o.value AS name FROM catalog c,json_each(c.data,'$.objects') o" + where + " AND json_type(c.data,'$.objects')='array' AND typeof(o.value)='text' ORDER BY o.value").all(...range.values).map((row) => row.name);
    const result = { albums, creators, objectClasses };
    if (this._filterOptionsCache.size >= 16) this._filterOptionsCache.delete(this._filterOptionsCache.keys().next().value);
    this._filterOptionsCache.set(key, result);
    return result;
  }

  albums(guestOnly = false, folderPath = '') {
    return this.filterOptions(guestOnly, folderPath).albums;
  }

  creators(guestOnly = false, folderPath = '') {
    return this.filterOptions(guestOnly, folderPath).creators;
  }

  count() {
    return this.items.size;
  }

  setGuest(id, guest) {
    const item = this.items.get(id);
    if (!item) return null;
    this.store.update(item, { guest: !!guest });
    this._scheduleSave();
    return item;
  }

  setGuestForAlbum(album, guest) {
    let changed = 0;
    for (const item of this.items.values()) {
      if (item.album === album) {
        this.store.update(item, { guest: !!guest });
        changed++;
      }
    }
    if (changed) this._scheduleSave();
    return changed;
  }

  // sort: 'desc' | 'asc' (effective date) | 'name-asc' | 'name-desc' |
  // 'random' (requires `seed`, any string -- same seed = same order,
  // so pagination stays consistent for one shuffle session).
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
    guestOnly,
    has,
    q,
    sort,
    seed,
    dateField,
    dateFrom,
    dateTo,
    resolution
  }) {
    let list = Array.from(this.items.values());
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
    if (guestOnly) list = list.filter((i) => i.guest === true);
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

  // Every distinct object class YOLO has actually found in this
  // library, for populating the "Contains" filter dynamically instead
  // of a fixed guessed list.
  objectClasses(guestOnly = false, folderPath = '') {
    return this.filterOptions(guestOnly, folderPath).objectClasses;
  }

  // filter: { type, album, guestOnly, has, q, sort, seed, cursor, limit }
  query({
    type = null,
    album = null,
    folderPath = '',
    creator = null,
    guestOnly = false,
    has = null,
    q = '',
    sort = 'desc',
    seed = '',
    dateField = 'created',
    dateFrom = null,
    dateTo = null,
    resolution = 0,
    cursor = null,
    limit = 60
  } = {}) {
    const result = this.store.catalogPage({
      type,
      album,
      folderPath,
      creator,
      guestOnly,
      has,
      q,
      sort,
      seed,
      dateField,
      dateFrom,
      dateTo,
      resolution,
      cursor,
      limit
    });
    return {
      items: result.ids.map((id) => this.present(this.items.get(id))),
      nextCursor: result.nextCursor,
      total: result.total
    };
  }

  present(item) {
    if (item) {
      item.activity = this.store.activityStats(item);
      item.variants = this.store.variants(item);
    }
    return item;
  }

  // Position of an item within the full (filtered, sorted) stream --
  // used for the lightbox's frame counter and prev/next. Must be
  // called with the same filters the caller is browsing under, or the
  // index and neighbors won't line up with what they see.
  neighbors(
    id,
    {
      guestOnly = false,
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
        guestOnly,
        has,
        q,
        sort,
        seed,
        type,
        album,
        folderPath,
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

  // Groups items whose perceptual hash is within `threshold` Hamming
  // distance of each other -- recompressed/resized/near-identical
  // burst shots, not exact-byte duplicates. O(n^2) comparisons: fine
  // for a personal library (thousands of items); a very large one
  // (100k+) would want a smarter bucketing strategy instead.
  duplicateGroups({ threshold = 10, guestOnly = false } = {}) {
    let items = Array.from(this.items.values()).filter((i) => i.pHash);
    if (guestOnly) items = items.filter((i) => i.guest === true);

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
