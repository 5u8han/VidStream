'use strict';
const { renderShell } = require('../template');
const { publicItem } = require('../serialize');
const { isAdmin } = require('../auth');

function pageHandler(cfg, db) {
  return (req, res, params) => {
    const owner = isAdmin(req, cfg);
    let status = 200;
    let initialItem = null;
    if (params && params.id) {
      const item = db.get(params.id);
      // A private item 404s for non-admins exactly like a nonexistent
      // one -- no metadata/OG tags leak either way.
      if (!item || (item.guest !== true && !owner)) status = 404;
      else initialItem = publicItem(item, cfg);
    }
    const html = renderShell(cfg, { initialItem, isAdmin: owner, savedUI: owner ? db.store.setting('ui',{}) : {}, tracking: db.store.setting('tracking',true) });
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  };
}

module.exports = { pageHandler };
