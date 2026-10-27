'use strict';
const { renderShell } = require('../template');
const { publicItem } = require('../serialize');
const { isAdmin } = require('../auth');

function pageHandler(cfg, db) {
  return (req, res, params) => {
    let initialItem = null;
    if (params && params.id) {
      const item = db.get(params.id);
      // A private item 404s for non-admins exactly like a nonexistent
      // one -- no metadata/OG tags leak either way.
      if (!item || (item.guest !== true && !isAdmin(req, cfg))) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderShell(cfg));
        return;
      }
      initialItem = publicItem(item, cfg);
    }
    const html = renderShell(cfg, { initialItem, isAdmin: isAdmin(req, cfg) });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  };
}

module.exports = { pageHandler };
