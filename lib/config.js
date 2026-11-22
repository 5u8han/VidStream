'use strict';
const { PORTABLE_STORAGE_DIRECTORY } = require('./catalog');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const THEMES = new Set(['system', 'light-table', 'darkroom', 'golden-hour', 'contact-sheet']);

function parseEnvFile(filePath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numList(v, fallback) {
  if (!v) return fallback;
  const nums = v.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  return nums.length ? Array.from(new Set(nums)).sort((a, b) => a - b) : fallback;
}

function sizesConfig(env, listKey, legacyMaxKey, defaultSizes) {
  if (env[listKey]) return numList(env[listKey], defaultSizes);
  if (env[legacyMaxKey]) {
    const n = num(env[legacyMaxKey], null);
    if (n) return [n];
  }
  return defaultSizes;
}

function readMediaFolders(mediaDir, mode, primaryMount, orderJson) {
  if (mode === 'manual') return null;
  if (mode !== 'mounted') throw new Error('MEDIA_FOLDER_MODE must be manual or mounted');
  try {
    const folders = fs.readdirSync(mediaDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== PORTABLE_STORAGE_DIRECTORY)
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (orderJson) {
      const order = JSON.parse(orderJson);
      if (!Array.isArray(order) || !order.every(name => typeof name === 'string'))
        throw new Error('MEDIA_FOLDER_ORDER must contain an array of folder names.');
      const rank = new Map(order.map((name, index) => [name, index]));
      folders.sort((a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length));
    }
    if (primaryMount) {
      const target = path.resolve(mediaDir, primaryMount);
      const index = folders.findIndex(name => path.join(mediaDir, name) === target);
      if (index > 0) folders.unshift(folders.splice(index, 1)[0]);
    }
    return folders;
  } catch (error) {

    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function resolveSessionSecret(env, dataDir, cacheDir, snapshotDir) {
  const given = env.SESSION_SECRET;
  if (given && given !== 'change-me-to-something-random' && given !== 'stream-dev-secret-change-me') return given;
  const file = path.join(dataDir, 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  let secret;

  const legacyDirs = [cacheDir];
  if (snapshotDir) legacyDirs.push(path.dirname(snapshotDir));
  for (const legacyDir of legacyDirs) {
    try {
      const legacy = fs.readFileSync(path.join(legacyDir, 'session-secret'), 'utf8').trim();
      if (legacy.length >= 32) { secret = legacy; break; }
    } catch {}
  }
  if (!secret) secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {}
  return secret;
}

function loadConfig(rootDir) {
  const envPath = path.join(rootDir, '.env');
  const fileEnv = parseEnvFile(envPath);
  const env = Object.assign({}, fileEnv, process.env);

  const mediaDir = path.resolve(rootDir, env.MEDIA_DIR || 'media/original');
  const mediaFolders = readMediaFolders(mediaDir, env.MEDIA_FOLDER_MODE || 'manual', env.MEDIA_PRIMARY_MOUNT, env.MEDIA_FOLDER_ORDER);
  const cacheDir = path.resolve(rootDir, env.CACHE_DIR || '.cache');
  const dataDir = path.resolve(rootDir, env.DATA_DIR || path.join(cacheDir, 'library-data'));
  const cacheSnapshotDir = env.CACHE_SNAPSHOT_DIR ? path.resolve(rootDir, env.CACHE_SNAPSHOT_DIR) : '';

  return {
    rootDir,
    originalsDir: path.resolve(rootDir, env.ORIGINALS_DIR || 'originals/original'),
    mediaDir,
    mediaFolders,
    cacheDir,
    dataDir,
    cacheSnapshotDir,
    cacheColdStart: bool(env.CACHE_COLD_START, false),
    cacheMaxBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(num(env.CACHE_MAX_BYTES, 0)))),
    port: num(env.PORT, 4000),
    host: env.HOST || '0.0.0.0',

    title: env.TITLE || 'Stream',
    defaultTheme: THEMES.has(env.DEFAULT_THEME) ? env.DEFAULT_THEME : 'system',
    dockerRuntime: bool(env.VIDSTREAM_DOCKER, false),
    setupHelperUsed: bool(env.VIDSTREAM_SETUP_HELPER, false),
    updateDirectory: env.VIDSTREAM_UPDATE_DIR ? path.resolve(rootDir, env.VIDSTREAM_UPDATE_DIR) : '',
    appRevision: env.VIDSTREAM_REVISION || '',
    description: env.DESCRIPTION || '',
    authorName: env.AUTHOR_NAME || '',
    authorEmail: env.AUTHOR_EMAIL || '',
    authorWebsite: env.AUTHOR_WEBSITE || '',
    url: (env.URL || '').replace(/\/+$/, ''),
    nodeName: env.NODE_NAME || env.TITLE || 'Stream',
    nodeUrl: env.NODE_URL || '',
    nodeRole: env.VIDSTREAM_ROLE === 'node' ? 'node' : 'server',
    nodeDiscovery: bool(env.NODE_DISCOVERY, false),

    showOfficialLink: bool(env.SHOW_OFFICIAL_LINK, false),
    defaultReverseSort: bool(env.DEFAULT_REVERSE_SORT, false),
    allowOrderSortChange: bool(env.ALLOW_ORDER_SORT_CHANGE, true),
    allowOriginalDownload: bool(env.ALLOW_ORIGINAL_DOWNLOAD, true),

    twitterUsername: env.TWITTER_USERNAME || '',
    githubUsername: env.GITHUB_USERNAME || '',
    instagramUsername: env.INSTAGRAM_USERNAME || '',
    customLinkUrl: env.CUSTOM_LINK_URL || '',
    customLinkName: env.CUSTOM_LINK_NAME || '',

    adminPassword: env.ADMIN_PASSWORD || env.SITE_PASSWORD || '',

    adminUsername: env.ADMIN_USERNAME || '',
    sessionSecret: resolveSessionSecret(env, dataDir, cacheDir, cacheSnapshotDir),

    ldapUrl: env.LDAP_URL || '',
    ldapBindDnTemplate: env.LDAP_BIND_DN_TEMPLATE || '',
    ldapBaseDn: env.LDAP_BASE_DN || '',

    trustProxy: bool(env.TRUST_PROXY, false),

    scanOnStart: bool(env.SCAN_ON_START, false),
    watchForChanges: bool(env.WATCH_FOR_CHANGES, false),
    rescanIntervalMinutes: num(env.RESCAN_INTERVAL_MINUTES, 0),

    videoAutoplayPreviews: bool(env.VIDEO_AUTOPLAY_PREVIEWS, true),
    videoPreviewDuration: num(env.VIDEO_PREVIEW_DURATION, 5),
    videoPreviewFps: Math.max(1, Math.min(60, num(env.VIDEO_PREVIEW_FPS, 60))),
    videoPreviewMaxWidth: num(env.VIDEO_PREVIEW_MAX_WIDTH, 480),
    videoTimelineCacheMiB: Math.min(65_536, Math.max(0, Math.floor(num(env.VIDEO_TIMELINE_CACHE_MIB, 0)))),
    videoEncoder: env.VIDEO_ENCODER === 'qsv' ? 'qsv' : 'software',
    qsvDevice: env.QSV_DEVICE || '/dev/dri/renderD128',

    thumbnailSizes: sizesConfig(env, 'THUMBNAIL_SIZES', 'THUMBNAIL_MAX', [320, 640, 960]),
    largeSizes: sizesConfig(env, 'LARGE_SIZES', 'LARGE_MAX', [1280, 2048]),
    posterSizes: sizesConfig(env, 'POSTER_SIZES', 'POSTER_MAX', [480, 960]),

    processingConcurrency: num(env.PROCESSING_CONCURRENCY, 0),
    scanWorkerMultiplier: num(env.SCAN_WORKER_MULTIPLIER, 1) === 2 ? 2 : 1,
    scanReadConcurrency: Math.min(64, Math.max(0, Math.floor(num(env.SCAN_READ_CONCURRENCY, 0)))),

    enableFaceDetection: bool(env.ENABLE_FACE_DETECTION, true),
    enablePetDetection: bool(env.ENABLE_PET_DETECTION, true),
    enableOcr: bool(env.ENABLE_OCR, true),
    enableDuplicateDetection: bool(env.ENABLE_DUPLICATE_DETECTION, true),

    enableObjectDetection: bool(env.ENABLE_OBJECT_DETECTION, false),

    duplicateThreshold: num(env.DUPLICATE_THRESHOLD, 10),
  };
}

module.exports = { loadConfig };
