'use strict';
const { isAdmin } = require('./auth');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function buildFeed(cfg, db, guestOnly) {
  const { items } = db.query({ sort: 'desc', limit: 60, guestOnly });
  const siteUrl = cfg.url || '';
  const now = new Date().toUTCString();

  const entries = items.map((item) => {
    const link = `${siteUrl}/${item.id}`;
    const mediaUrl =
      item.type === 'photo'
        ? `${siteUrl}/media/${item.id}/large`
        : `${siteUrl}/media/${item.id}/original`;
    const mime = item.type === 'photo' ? (item.thumbExt === '.png' ? 'image/png' : 'image/jpeg') : 'video/mp4';
    const pubDate = new Date(item.dateTaken || item.mtime).toUTCString();
    const posterUrl = item.type === 'video' ? `${siteUrl}/media/${item.id}/poster` : mediaUrl;
    return `  <item>
    <title>${esc(item.filename)}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${pubDate}</pubDate>
    <enclosure url="${esc(mediaUrl)}" type="${mime}" length="${item.size || 0}"/>
    <description><![CDATA[<img src="${esc(posterUrl)}" />]]></description>
  </item>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(cfg.title)}</title>
  <link>${esc(siteUrl)}</link>
  <description>${esc(cfg.description)}</description>
  <lastBuildDate>${now}</lastBuildDate>
${entries.join('\n')}
</channel>
</rss>
`;
}

function feedHandler(cfg, db) {
  return (req, res) => {
    if (!cfg.showRssFeed) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // isAdmin() already resolves to true when no admin password is
    // configured at all, so a plain public install (the common case)
    // still gets every item in its feed -- guestOnly filtering only
    // actually kicks in once the admin/guest system is turned on.
    const xml = buildFeed(cfg, db, !isAdmin(req, cfg));
    res.writeHead(200, {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(xml);
  };
}

module.exports = { feedHandler, buildFeed };
