'use strict';
const { authConfigured } = require('./auth');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// Safe to embed inside a single-quoted HTML attribute: escapes & and '
// (the delimiter) plus < as a defense-in-depth measure against breaking
// out into a </script> context.
function jsonForAttr(obj) {
  return JSON.stringify(obj)
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '\\u003c');
}

const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='15' fill='%23121012'/><g fill='none' stroke='%23C1443C' stroke-width='2.1'><circle cx='16' cy='16' r='9.5'/></g><circle cx='16' cy='16' r='3.4' fill='%23C1443C'/></svg>";

// Runs before the stylesheet even loads, so a saved theme/density
// choice applies on first paint instead of flashing the default first.
const THEME_RESTORE_SCRIPT = `(function(){try{
var t=localStorage.getItem('stream-theme');
if(t&&t!=='system')document.documentElement.setAttribute('data-theme',t);
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

  const clientConfig = {
    title: cfg.title,
    savedUI, tracking, setupRequired:!!cfg.setupRequired,
    url: cfg.url,
    showRssFeed: cfg.showRssFeed,
    allowOrderSortChange: cfg.allowOrderSortChange,
    defaultReverseSort: cfg.defaultReverseSort,
    allowOriginalDownload: cfg.allowOriginalDownload,
    allowSharing: cfg.allowSharing,
    twitterUsername: cfg.twitterUsername,
    githubUsername: cfg.githubUsername,
    instagramUsername: cfg.instagramUsername,
    customLinkUrl: cfg.customLinkUrl,
    customLinkName: cfg.customLinkName,
    videoAutoplayPreviews: cfg.videoAutoplayPreviews,
    // Whether admin sign-in exists as a concept on this install at
    // all (shows/hides the "Sign in" control), vs. whether *this*
    // session currently holds the admin role.
    adminEnabled: authConfigured(cfg),
    isAdmin,
    locked,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
${cfg.allowIndexing ? '' : '<meta name="robots" content="noindex, nofollow">'}
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
<link rel="stylesheet" href="/styles.css">
${cfg.showRssFeed ? `<link rel="alternate" type="application/rss+xml" title="${esc(cfg.title)}" href="/feed.xml">` : ''}
</head>
<body>
<div id="app" data-config='${jsonForAttr(clientConfig)}' data-initial='${initialItem ? jsonForAttr(initialItem) : ''}'></div>
<script src="/ambient.js"></script>
<script src="/activity.js"></script>
<script src="/resources.js"></script>
<script src="/settings.js"></script>
<script src="/library-layout.js"></script>
<script src="/artist-outlines.js"></script>
<script src="/library-map.js"></script>
<script src="/app.js"></script>
</body>
</html>
`;
}

module.exports = { renderShell };
