'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env parser -- no npm dependency. Supports KEY=VALUE, quoted
// values, #comments, and blank lines. Existing process.env values win
// (so `PORT=4000 node server.js` can still override the .env file).
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

// The session secret signs the admin cookie, so a publicly-known
// default would let anyone forge an admin session. Use SESSION_SECRET if
// it's a real value; otherwise generate a random one once and persist it
// in the cache dir (so sessions survive restarts). The placeholder from
// .env.example is treated as unset, since people copy that file as-is.
function resolveSessionSecret(env, cacheDir) {
  const given = env.SESSION_SECRET;
  if (given && given !== 'change-me-to-something-random' && given !== 'stream-dev-secret-change-me') return given;
  const file = path.join(cacheDir, 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch { /* unwritable cache dir: fall back to a per-process secret */ }
  return secret;
}

function loadConfig(rootDir) {
  const envPath = path.join(rootDir, '.env');
  const fileEnv = parseEnvFile(envPath);
  const env = Object.assign({}, fileEnv, process.env);

  const mediaDir = path.resolve(rootDir, env.MEDIA_DIR || 'media/original');
  const cacheDir = path.resolve(rootDir, env.CACHE_DIR || '.cache');

  return {
    rootDir,
    originalsDir: path.resolve(rootDir, env.ORIGINALS_DIR || 'originals/original'),
    mediaDir,
    cacheDir,
    dataDir: path.resolve(rootDir, env.DATA_DIR || path.join(cacheDir, "library-data")),
    port: num(env.PORT, 4000),
    host: env.HOST || '0.0.0.0',

    title: env.TITLE || 'Stream',
    description: env.DESCRIPTION || '',
    authorName: env.AUTHOR_NAME || '',
    authorEmail: env.AUTHOR_EMAIL || '',
    authorWebsite: env.AUTHOR_WEBSITE || '',
    url: (env.URL || '').replace(/\/+$/, ''),
    nodeName: env.NODE_NAME || env.TITLE || 'Stream',
    nodeUrl: env.NODE_URL || '',
    nodeDiscovery: bool(env.NODE_DISCOVERY, false),

    showRssFeed: bool(env.SHOW_RSS_FEED, true),
    showOfficialLink: bool(env.SHOW_OFFICIAL_LINK, false),
    defaultReverseSort: bool(env.DEFAULT_REVERSE_SORT, false),
    allowOrderSortChange: bool(env.ALLOW_ORDER_SORT_CHANGE, true),
    allowOriginalDownload: bool(env.ALLOW_ORIGINAL_DOWNLOAD, true),
    allowIndexing: bool(env.ALLOW_INDEXING, true),
    allowSharing: bool(env.ALLOW_IMAGE_SHARING, true),

    twitterUsername: env.TWITTER_USERNAME || '',
    githubUsername: env.GITHUB_USERNAME || '',
    instagramUsername: env.INSTAGRAM_USERNAME || '',
    customLinkUrl: env.CUSTOM_LINK_URL || '',
    customLinkName: env.CUSTOM_LINK_NAME || '',

    // ADMIN_PASSWORD gates admin sign-in (full library + visibility
    // controls). SITE_PASSWORD remains an alias. If no credentials or LDAP
    // are configured, the server requires first-time owner setup.
    adminPassword: env.ADMIN_PASSWORD || env.SITE_PASSWORD || '',
    // Optional: require this username alongside ADMIN_PASSWORD (blank = any
    // username works with the right password, as in the original design).
    adminUsername: env.ADMIN_USERNAME || '',
    sessionSecret: resolveSessionSecret(env, cacheDir),
    // LDAP is an alternative way to satisfy sign-in: bind as the entered
    // user against this server. Leave LDAP_URL unset to skip it entirely.
    ldapUrl: env.LDAP_URL || '',
    ldapBindDnTemplate: env.LDAP_BIND_DN_TEMPLATE || '',
    ldapBaseDn: env.LDAP_BASE_DN || '',
    // REQUIRE_LOGIN=1 makes the whole app private: signed-out visitors
    // get only a login screen (no gallery UI, no media, no API).
    requireLogin: bool(env.REQUIRE_LOGIN, false),
    // Key the login rate limiter on the forwarded client IP -- enable
    // only behind a proxy you control (e.g. Cloudflare Tunnel).
    trustProxy: bool(env.TRUST_PROXY, false),

    watchForChanges: bool(env.WATCH_FOR_CHANGES, true),
    rescanIntervalMinutes: num(env.RESCAN_INTERVAL_MINUTES, 0),

    videoAutoplayPreviews: bool(env.VIDEO_AUTOPLAY_PREVIEWS, true),
    videoPreviewDuration: num(env.VIDEO_PREVIEW_DURATION, 5),
    videoPreviewFps: Math.max(1, Math.min(60, num(env.VIDEO_PREVIEW_FPS, 60))),
    videoPreviewMaxWidth: num(env.VIDEO_PREVIEW_MAX_WIDTH, 480),

    // Each is a list of widths (px, longest edge) to generate, enabling
    // responsive srcset loading. A single legacy *_MAX value still
    // works and is treated as a one-item list.
    thumbnailSizes: sizesConfig(env, 'THUMBNAIL_SIZES', 'THUMBNAIL_MAX', [320, 640, 960]),
    largeSizes: sizesConfig(env, 'LARGE_SIZES', 'LARGE_MAX', [1280, 2048]),
    posterSizes: sizesConfig(env, 'POSTER_SIZES', 'POSTER_MAX', [480, 960]),

    processingConcurrency: num(env.PROCESSING_CONCURRENCY, 2),

    // Detection is scoped to whole-person/whole-animal presence and
    // text extraction for library organization and search -- not
    // fine-grained body-region analysis. Each is independently
    // toggleable since they add real processing time per item.
    enableFaceDetection: bool(env.ENABLE_FACE_DETECTION, true),
    enablePetDetection: bool(env.ENABLE_PET_DETECTION, true),
    enableOcr: bool(env.ENABLE_OCR, true),
    enableDuplicateDetection: bool(env.ENABLE_DUPLICATE_DETECTION, true),
    // Same variable name as the Docker build ARG that controls whether
    // the PyTorch/ultralytics stack is even *in* the image (see
    // Dockerfile) -- this one controls whether it's actually *used* at
    // runtime, so you can build it in but flip it off without a
    // rebuild. Defaults on to match the build arg's default; harmless
    // either way since detectObjects() degrades to [] if the model
    // weights genuinely aren't present in this image.
    enableObjectDetection: bool(env.ENABLE_OBJECT_DETECTION, false),
    // Two hashes at or below this Hamming distance (0-64) are grouped
    // as likely duplicates.
    duplicateThreshold: num(env.DUPLICATE_THRESHOLD, 10),
  };
}

module.exports = { loadConfig };
