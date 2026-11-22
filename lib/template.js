'use strict';
const { version: VERSION } = require('../package.json');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function jsonForAttr(obj) {
  return JSON.stringify(obj)
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '\\u003c');
}

const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='15' fill='%23121012'/><g fill='none' stroke='%23C1443C' stroke-width='2.1'><circle cx='16' cy='16' r='9.5'/></g><circle cx='16' cy='16' r='3.4' fill='%23C1443C'/></svg>";

const THEME_RESTORE_SCRIPT = `(function(){try{
var t=localStorage.getItem('stream-theme');
if(t==='system')document.documentElement.removeAttribute('data-theme');
else if(t)document.documentElement.setAttribute('data-theme',t);
var d=localStorage.getItem('stream-density');
if(d)document.documentElement.setAttribute('data-density',d);
}catch(e){}})();`;

function renderShell(cfg, { initialItem = null, isAdmin = false, locked = false, savedUI = {}, tracking = true } = {}) {
  const title = initialItem
    ? `${esc(initialItem.filename)} · ${esc(cfg.title)}`
    : esc(cfg.title);
  const description = esc(cfg.description || `${cfg.title} — a photo and video stream.`);
  const ogImage = initialItem
    ? `${cfg.url}${initialItem.urls.thumb}`
    : `${cfg.url}/social-preview.png`;

  const buildRevision = /^[a-f0-9]{40}$/.test(cfg.appRevision || '') ? cfg.appRevision : null;
  const assetVersion = encodeURIComponent(buildRevision || VERSION);
  const clientConfig = {
    title: cfg.title,
    defaultTheme: cfg.defaultTheme || 'system',
    node: cfg.node || null,
    version: VERSION,
    buildRevision,
    features: { nodes: Boolean(cfg.node) },
    savedUI, tracking, setupRequired:!!cfg.setupRequired,
    loginNeedsUsername: Boolean(cfg.ldapUrl && cfg.ldapBindDnTemplate),
    allowOrderSortChange: cfg.allowOrderSortChange,
    defaultReverseSort: cfg.defaultReverseSort,
    allowOriginalDownload: cfg.allowOriginalDownload,
    twitterUsername: cfg.twitterUsername,
    githubUsername: cfg.githubUsername,
    instagramUsername: cfg.instagramUsername,
    customLinkUrl: cfg.customLinkUrl,
    customLinkName: cfg.customLinkName,
    videoAutoplayPreviews: cfg.videoAutoplayPreviews,
    isAdmin,
    locked,
  };

  return `<!doctype html>
<html lang="en"${cfg.defaultTheme && cfg.defaultTheme !== 'system' ? ` data-theme="${esc(cfg.defaultTheme)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="robots" content="noindex, nofollow">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="${initialItem ? (initialItem.type === 'video' ? 'video.other' : 'article') : 'website'}">
${cfg.url ? `<meta property="og:url" content="${esc(cfg.url)}${initialItem ? '/' + esc(initialItem.id) : ''}">` : ''}
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${FAVICON_SVG}">
<script>${THEME_RESTORE_SCRIPT}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css?v=${assetVersion}">
<link rel="stylesheet" href="/design.css?v=${assetVersion}">
<link rel="stylesheet" href="/controls.css?v=${assetVersion}">
<link rel="stylesheet" href="/options.css?v=${assetVersion}">
<link rel="stylesheet" href="/nodes.css?v=${assetVersion}">
<link rel="stylesheet" href="/benchmark.css?v=${assetVersion}">
<link rel="stylesheet" href="/dashboard-notifications.css?v=${assetVersion}">
<link rel="stylesheet" href="/folders.css?v=${assetVersion}">
</head>
<body>
<div id="app" data-config='${jsonForAttr(clientConfig)}' data-initial='${initialItem ? jsonForAttr(initialItem) : ''}'></div>
<script src="/ambient.js?v=${assetVersion}"></script>
<script src="/activity.js?v=${assetVersion}"></script>
<script src="/resources.js?v=${assetVersion}"></script>
<script src="/navigation.js?v=${assetVersion}"></script>
<script src="/host-settings.js?v=${assetVersion}"></script>
<script src="/settings.js?v=${assetVersion}"></script>
<script src="/library-tools.js?v=${assetVersion}"></script>
<script src="/library-layout.js?v=${assetVersion}"></script>
<script src="/library-map.js?v=${assetVersion}"></script>
<script src="/player-stats.js?v=${assetVersion}"></script>
<script src="/preview-memory.js?v=${assetVersion}"></script>
<script src="/preview-controller.js?v=${assetVersion}"></script>
<script src="/benchmark.js?v=${assetVersion}"></script>
<script src="/dashboard-notifications.js?v=${assetVersion}"></script>
<script src="/diagnostics.js?v=${assetVersion}"></script>
<script src="/entrance.js?v=${assetVersion}"></script>
<script src="/nodes.js?v=${assetVersion}"></script>
<script src="/folders.js?v=${assetVersion}"></script>
<script src="/app.js?v=${assetVersion}"></script>
</body>
</html>
`;
}

module.exports = { renderShell };
