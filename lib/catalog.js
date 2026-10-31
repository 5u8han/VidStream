'use strict';
const crypto = require('node:crypto');

function sourceVersion(item) {
  if (item.sourceVersion) return item.sourceVersion;
  if (item.sourceHash) return item.sourceHash;
  const stat = /^(\d+(?:\.\d+)?):(\d+)(?::|$)/.exec(item.fingerprint || '');
  if (stat) return 'stat:' + stat[1] + ':' + stat[2];
  return item.fingerprint || (item.mtime ? 'stat:' + item.mtime + ':' + (item.size || 0) : null);
}
function identity() {
  return crypto.randomUUID();
}
function seedHash(id, seed) {
  let h = 2166136261;
  for (const character of String(id) + String(seed || ''))
    h = Math.imul(h ^ character.charCodeAt(0), 16777619);
  return h >>> 0;
}
function schema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS catalog (
    id TEXT PRIMARY KEY, media_id TEXT NOT NULL UNIQUE, rel_path TEXT NOT NULL UNIQUE,
    source_version TEXT, source_hash TEXT, type TEXT, album TEXT, creator TEXT,
    filename TEXT, date_key TEXT, date_added TEXT, width INTEGER, height INTEGER,
    favorite INTEGER NOT NULL, pinned INTEGER NOT NULL, bookmarked INTEGER NOT NULL,
    guest INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS catalog_path ON catalog(rel_path);
    CREATE INDEX IF NOT EXISTS catalog_source_hash ON catalog(source_hash);
    CREATE INDEX IF NOT EXISTS catalog_date ON catalog(date_key,id);
    CREATE INDEX IF NOT EXISTS catalog_creator ON catalog(creator,filename);
    CREATE TABLE IF NOT EXISTS catalog_aliases(alias TEXT PRIMARY KEY,media_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_variants(media_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(media_id,id));`);
  sql.function('stream_hash', { deterministic: true }, seedHash);
}
function save(sql, item) {
  const data = { ...item };
  delete data.history;
  delete data.activity;
  delete data.variants;
  sql
    .prepare(
      `INSERT INTO catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,rel_path=excluded.rel_path,
    source_version=excluded.source_version,source_hash=excluded.source_hash,type=excluded.type,
    album=excluded.album,creator=excluded.creator,filename=excluded.filename,date_key=excluded.date_key,
    date_added=excluded.date_added,width=excluded.width,height=excluded.height,favorite=excluded.favorite,
    pinned=excluded.pinned,bookmarked=excluded.bookmarked,guest=excluded.guest,data=excluded.data`
    )
    .run(
      item.id,
      item.mediaId,
      item.relPath || item.id,
      sourceVersion(item),
      item.sourceHash || null,
      item.type || null,
      item.album || null,
      item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)'),
      item.filename || item.id,
      item.dateTaken || item.mtime || null,
      item.addedAt || null,
      item.width || null,
      item.height || null,
      Number(item.favorite === true),
      Number(item.pinned === true),
      Number(item.bookmarked === true),
      Number(item.guest === true),
      JSON.stringify(data)
    );
  sql.prepare('INSERT OR REPLACE INTO catalog_aliases VALUES(?,?)').run(item.id, item.mediaId);
}
function selection(options) {
  const conditions = [],
    values = [];
  function add(condition, value) {
    conditions.push(condition);
    values.push(value);
  }
  for (const [key, column] of [
    ['type', 'c.type'],
    ['album', 'c.album'],
    ['creator', 'c.creator']
  ])
    if (options[key]) add(column + '=?', options[key]);
  if (options.guestOnly) conditions.push('c.guest=1');
  const date = options.dateField === 'imported' ? 'c.date_added' : 'c.date_key';
  if (options.dateFrom) add('substr(' + date + ',1,10)>=?', options.dateFrom);
  if (options.dateTo) add('substr(' + date + ',1,10)<=?', options.dateTo);
  if (options.resolution) {
    add('MIN(c.width,c.height)>=?', options.resolution);
  }
  if (['favorite', 'pinned', 'bookmarked'].includes(options.has))
    conditions.push('c.' + options.has + '=1');
  else if (options.has) {
    const flag = { face: 'hasFace', cat: 'hasCat', text: 'hasText' }[options.has];
    if (flag) conditions.push("json_extract(c.data,'$." + flag + "')=1");
    else add("EXISTS(SELECT 1 FROM json_each(c.data,'$.objects') WHERE value=?)", options.has);
  }
  if (options.q) {
    const needle = String(options.q).toLowerCase();
    conditions.push(
      "(instr(lower(c.filename),?)>0 OR instr(lower(COALESCE(c.album,'')),?)>0 OR instr(lower(COALESCE(json_extract(c.data,'$.creatorAlias'),'')),?)>0 OR instr(lower(COALESCE(json_extract(c.data,'$.ocrText'),'')),?)>0 OR EXISTS(SELECT 1 FROM json_each(c.data,'$.objects') WHERE instr(lower(value),?)>0))"
    );
    values.push(needle, needle, needle, needle, needle);
  }
  if (options.sort === 'continue')
    conditions.push(
      "COALESCE(a.last_position,0)>0 AND (json_extract(c.data,'$.duration') IS NULL OR a.last_position<json_extract(c.data,'$.duration')-MIN(2,json_extract(c.data,'$.duration')*.05))"
    );
  const sorts = {
    'name-asc': 'c.filename COLLATE NOCASE ASC,c.id ASC',
    'name-desc': 'c.filename COLLATE NOCASE DESC,c.id ASC',
    creator: 'c.creator COLLATE NOCASE ASC,c.filename COLLATE NOCASE ASC,c.id ASC',
    asc: 'c.date_key ASC,c.id ASC',
    desc: 'c.date_key DESC,c.id ASC',
    recent: 'a.last_opened DESC,c.id ASC',
    continue: 'a.last_opened DESC,c.id ASC',
    'less-seen': 'COALESCE(a.opens,0) ASC,COALESCE(a.watch_seconds,0) ASC,c.id ASC'
  };
  let order = sorts[options.sort] || sorts.desc;
  if (options.sort === 'random') {
    order = 'stream_hash(c.id,?) ASC,c.id ASC';
    values.unshift(options.seed || '');
  }
  if (options.sort === 'less-seen') {
    order =
      'COALESCE(a.opens,0) ASC,COALESCE(a.watch_seconds,0) ASC,stream_hash(c.id,?) ASC,c.id ASC';
    values.unshift(options.seed || '');
  }
  if (!['creator', 'recent', 'continue', 'less-seen'].includes(options.sort))
    order = 'c.pinned DESC,c.favorite DESC,c.bookmarked DESC,' + order;
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return {
    sql:
      'SELECT c.id,row_number() OVER(ORDER BY ' +
      order +
      ') AS position FROM catalog c LEFT JOIN activity_totals a ON a.path=c.rel_path' +
      where,
    values
  };
}
module.exports = { identity, sourceVersion, schema, save, selection };
