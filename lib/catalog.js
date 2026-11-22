'use strict';
const crypto = require('node:crypto');
const { folderRange } = require('./folder-collections');
const ARCHIVE_DIRECTORY = '.vidstream-source-originals';
const PORTABLE_STORAGE_DIRECTORY = 'vidstream-local';
const SOURCE_PATH_FILTER = `instr('/' || c.rel_path || '/', '/${ARCHIVE_DIRECTORY}/')=0
  AND instr('/' || c.rel_path || '/', '/${PORTABLE_STORAGE_DIRECTORY}/')=0`;
const ARCHIVED_EXPRESSION = "json_extract(data,'$.availability')='archived'";
const VISIBLE_MEDIA_FILTER = 'c.id NOT IN (SELECT id FROM catalog WHERE ' + ARCHIVED_EXPRESSION + ') AND ' + SOURCE_PATH_FILTER;

function folderKey(column) {
  return `replace(coalesce(${column},''),'/',char(0))`;
}

function mediaRange(mediaFolders, folderPath = '') {
  if (mediaFolders == null) return folderRange(folderPath);
  if (folderPath) {
    return mediaFolders.includes(folderPath.split('/', 1)[0])
      ? folderRange(folderPath)
      : { sql: '0', values: [] };
  }
  if (!mediaFolders.length) return { sql: '0', values: [] };
  return {
    sql: `c.rowid IN (
      SELECT scoped.rowid FROM json_each(?) AS folders CROSS JOIN catalog AS scoped
      WHERE scoped.rel_path >= folders.value || '/' AND scoped.rel_path < folders.value || '0'
    )`,
    values: [JSON.stringify(mediaFolders)]
  };
}

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
    CREATE INDEX IF NOT EXISTS catalog_recent_order ON catalog(pinned DESC,favorite DESC,bookmarked DESC,date_key DESC,id ASC);
    CREATE INDEX IF NOT EXISTS catalog_oldest_order ON catalog(pinned DESC,favorite DESC,bookmarked DESC,date_key ASC,id ASC);
    CREATE INDEX IF NOT EXISTS catalog_creator ON catalog(creator,filename);
    CREATE INDEX IF NOT EXISTS catalog_folder_order ON catalog(${folderKey('album')},filename COLLATE NOCASE,id);
    CREATE TABLE IF NOT EXISTS catalog_aliases(alias TEXT PRIMARY KEY,media_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_variants(media_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(media_id,id));
    CREATE INDEX IF NOT EXISTS catalog_archived ON catalog(id) WHERE ${ARCHIVED_EXPRESSION};`);
  sql.function('stream_hash', { deterministic: true }, seedHash);
}
const writers = new WeakMap();

function save(sql, item) {
  const data = { ...item };
  delete data.history;
  delete data.activity;
  delete data.resumePosition;
  delete data.variants;
  let statements = writers.get(sql);
  if (!statements) {
    statements = {
      item: sql.prepare(`INSERT INTO catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id,rel_path=excluded.rel_path,
        source_version=excluded.source_version,source_hash=excluded.source_hash,type=excluded.type,
        album=excluded.album,creator=excluded.creator,filename=excluded.filename,date_key=excluded.date_key,
        date_added=excluded.date_added,width=excluded.width,height=excluded.height,favorite=excluded.favorite,
        pinned=excluded.pinned,bookmarked=excluded.bookmarked,guest=excluded.guest,data=excluded.data`),
      alias: sql.prepare(`INSERT INTO catalog_aliases VALUES(?,?)
        ON CONFLICT(alias) DO UPDATE SET media_id=excluded.media_id
        WHERE catalog_aliases.media_id<>excluded.media_id`)
    };
    writers.set(sql, statements);
  }
  statements.item.run(
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
  statements.alias.run(item.id, item.mediaId);
}
function selection(options) {
  const conditions = [VISIBLE_MEDIA_FILTER],
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
  if (options.folderPath || options.mediaFolders != null) {
    const range = mediaRange(options.mediaFolders, options.folderPath);
    conditions.push('(' + range.sql + ')');
    values.push(...range.values);
  }
  if (options.sort === 'folder' && options.folderPath) {
    add(folderKey('c.album') + '>=' + folderKey('?'), options.folderPath);
    add(folderKey('c.album') + '<(' + folderKey('?') + '||char(1))', options.folderPath);
  }
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
  const resume = "CASE WHEN p.media_id IS NULL THEN COALESCE(a.last_position,0) " +
    "WHEN p.source_version=COALESCE(c.source_version,'') THEN p.position ELSE 0 END";
  if (options.sort === 'continue')
    conditions.push(
      resume + ">0 AND (json_extract(c.data,'$.duration') IS NULL OR " + resume +
      "<json_extract(c.data,'$.duration')-MIN(2,json_extract(c.data,'$.duration')*.05))"
    );
  const sorts = {
    folder: folderKey('c.album') + ' ASC,c.filename COLLATE NOCASE ASC,c.id ASC',
    'name-asc': 'c.filename COLLATE NOCASE ASC,c.id ASC',
    'name-desc': 'c.filename COLLATE NOCASE DESC,c.id ASC',
    creator: 'c.creator COLLATE NOCASE ASC,c.filename COLLATE NOCASE ASC,c.id ASC',
    asc: 'c.date_key ASC,c.id ASC',
    desc: 'c.date_key DESC,c.id ASC',
    recent: 'a.last_opened DESC,c.id ASC',
    continue: 'COALESCE(p.saved_at, unixepoch(a.last_opened)*1000) DESC,c.id ASC',
    'less-seen': 'COALESCE(a.opens,0) ASC,COALESCE(a.watch_seconds,0) ASC,c.id ASC'
  };
  let order = sorts[options.sort] || sorts.desc;
  let orderValues = [];
  if (options.sort === 'random') {
    order = 'stream_hash(c.id,?) ASC,c.id ASC';
    orderValues = [options.seed || ''];
  }
  if (options.sort === 'less-seen') {
    order =
      'COALESCE(a.opens,0) ASC,COALESCE(a.watch_seconds,0) ASC,stream_hash(c.id,?) ASC,c.id ASC';
    orderValues = [options.seed || ''];
  }
  if (!['folder', 'creator', 'recent', 'continue', 'less-seen'].includes(options.sort))
    order = 'c.pinned DESC,c.favorite DESC,c.bookmarked DESC,' + order;
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const activity = ['recent', 'continue', 'less-seen'].includes(options.sort)
    ? ' LEFT JOIN activity_totals a ON a.path=c.rel_path' : '';
  const positions = options.sort === 'continue' ? ' LEFT JOIN playback_positions p ON p.media_id=c.media_id' : '';
  const from = ' FROM catalog c' + activity + positions + where;
  let nextPageSql;
  if (options.sort === 'folder') {
    const tuple = alias => `(${folderKey(alias + '.album')},${alias}.filename COLLATE NOCASE,${alias}.id)`;
    nextPageSql = 'SELECT c.id FROM catalog anchor CROSS JOIN catalog c' + where +
      ' AND anchor.id=? AND ' + tuple('c') + '>' + tuple('anchor') + ' ORDER BY ' + order + ' LIMIT ?';
  }
  if (options.includeTotal === false && ['asc', 'desc'].includes(options.sort)) {
    const comparison = options.sort === 'desc' ? '<' : '>';
    const nullOrder = options.sort === 'desc'
      ? '(c.date_key IS NULL AND anchor.date_key IS NOT NULL)'
      : '(c.date_key IS NOT NULL AND anchor.date_key IS NULL)';
    const after = `(c.pinned,c.favorite,c.bookmarked)<(anchor.pinned,anchor.favorite,anchor.bookmarked)
      OR ((c.pinned,c.favorite,c.bookmarked)=(anchor.pinned,anchor.favorite,anchor.bookmarked) AND (
        c.date_key ${comparison} anchor.date_key OR ${nullOrder} OR (c.date_key IS anchor.date_key AND c.id>anchor.id)
      ))`;
    nextPageSql = 'SELECT c.id FROM catalog anchor CROSS JOIN catalog c' + where + ' AND anchor.id=? AND (' + after + ') ORDER BY ' + order + ' LIMIT ?';
  }
  return {
    sql: 'SELECT c.id,row_number() OVER(ORDER BY ' + order + ') AS position' + from,
    values: [...orderValues, ...values],
    countSql: 'SELECT COUNT(*) AS count' + from,
    countValues: values,
    nextPageSql,
    nextPageValues: values,
    firstPageSql: 'SELECT c.id' + from + ' ORDER BY ' + order + ' LIMIT ?',
    firstPageValues: [...values, ...orderValues],
  };
}
module.exports = { identity, sourceVersion, schema, save, selection, mediaRange, folderKey, ARCHIVE_DIRECTORY, PORTABLE_STORAGE_DIRECTORY, SOURCE_PATH_FILTER, VISIBLE_MEDIA_FILTER };
