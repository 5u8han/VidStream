'use strict';
const fs = require('fs');
const path = require('path');
const { LibraryStore } = require('./library-store');
const { hammingDistance } = require('./vision-hash');

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

function creatorOf(item) { return item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)'); }

class Db {
  constructor(filePath, dataDir = path.join(path.dirname(filePath), "library-data")) {
    this.store = new LibraryStore(dataDir);
    this.filePath = filePath;
    this.revision = 0;
    this.items = new Map(); // id -> record
    this._saveTimer = null;
    this._load();
    for (const item of this.items.values()) this.store.hydrate(item);
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const arr = JSON.parse(raw);
      for (const item of arr) this.items.set(item.id, item);
    } catch {
      // No index yet -- first run.
    }
  }

  // Debounced so a burst of scanner writes (processing 200 photos)
  // doesn't hit disk 200 times.
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 500);
  }

  _saveNow() {
    const arr = Array.from(this.items.values());
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, this.filePath);
  }

  upsert(record) {
    this.store.hydrate(record);
    this.items.set(record.id, record);
    this.revision++;
    this._scheduleSave();
  }

  remove(id) {
    this.items.delete(id);
    this.revision++;
    this._scheduleSave();
  }

  get(id) {
    return this.items.get(id) || null;
  }

  has(id) {
    return this.items.has(id);
  }

  // relPath is the stable identity from a scan (not the slug, which is
  // derived and could theoretically change if slugging rules change).
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

  albums(guestOnly = false) {
    const set = new Set();
    for (const item of this.items.values()) {
      if ((!guestOnly || item.guest === true) && item.album) set.add(item.album);
    }
    return Array.from(set).sort();
  }

  creators(guestOnly = false) {
    const set = new Set();
    for (const item of this.items.values()) {
      if (!guestOnly || item.guest === true) set.add(creatorOf(item));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
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
      return (a, b) => creatorOf(a).localeCompare(creatorOf(b)) ||
        a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id);
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

  _filteredSorted({ type, album, creator, guestOnly, has, q, sort, seed, dateField, dateFrom, dateTo, resolution }) {
    let list = Array.from(this.items.values());
    if (type) list = list.filter((i) => i.type === type);
    if (album) list = list.filter((i) => i.album === album);
    if (creator) list = list.filter((i) => creatorOf(i) === creator);
    const field = dateField === 'imported' ? 'addedAt' : null;
    if (dateFrom || dateTo) list = list.filter((i) => {
      const value = field ? i[field] : this.effectiveDate(i);
      const day = value ? value.slice(0, 10) : '';
      return day && (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
    });
    if (resolution) list = list.filter((i) => {
      const shortEdge = Math.min(i.width || 0, i.height || 0);
      return shortEdge >= resolution;
    });
    if (guestOnly) list = list.filter((i) => i.guest === true);
    if (['favorite', 'pinned', 'bookmarked'].includes(has)) list = list.filter((i) => i[has] === true);
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
    if(sort==='creator')list.sort(compare);
    else list.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.favorite === true) - Number(a.favorite === true) || Number(b.bookmarked === true) - Number(a.bookmarked === true) || compare(a, b));
    return list;
  }

  // Every distinct object class YOLO has actually found in this
  // library, for populating the "Contains" filter dynamically instead
  // of a fixed guessed list.
  objectClasses(guestOnly = false) {
    const set = new Set();
    for (const item of this.items.values()) {
      if ((!guestOnly || item.guest === true) && Array.isArray(item.objects)) for (const o of item.objects) set.add(o);
    }
    return Array.from(set).sort();
  }

  // filter: { type, album, guestOnly, has, q, sort, seed, cursor, limit }
  query({ type = null, album = null, creator = null, guestOnly = false, has = null, q = '', sort = 'desc', seed = '', dateField = 'created', dateFrom = null, dateTo = null, resolution = 0, cursor = null, limit = 60 } = {}) {
    const list = this._filteredSorted({ type, album, creator, guestOnly, has, q, sort, seed, dateField, dateFrom, dateTo, resolution });

    let startIndex = 0;
    if (cursor) {
      const idx = list.findIndex((i) => i.id === cursor);
      startIndex = idx === -1 ? 0 : idx + 1;
    }
    const page = list.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < list.length ? page[page.length - 1].id : null;

    return { items: page, nextCursor, total: list.length };
  }

  // Position of an item within the full (filtered, sorted) stream --
  // used for the lightbox's frame counter and prev/next. Must be
  // called with the same filters the caller is browsing under, or the
  // index and neighbors won't line up with what they see.
  neighbors(id, { guestOnly = false, has = null, q = '', sort = 'desc', seed = '', type = null, album = null, creator = null, dateField = 'created', dateFrom = null, dateTo = null, resolution = 0 } = {}) {
    const list = this._filteredSorted({ type, album, creator, guestOnly, has, q, sort, seed, dateField, dateFrom, dateTo, resolution });
    const idx = list.findIndex((i) => i.id === id);
    if (idx === -1) return { index: -1, total: list.length, prev: null, next: null };
    return {
      index: idx,
      total: list.length,
      prev: idx > 0 ? list[idx - 1] : null,
      next: idx < list.length - 1 ? list[idx + 1] : null,
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
