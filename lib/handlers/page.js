'use strict';
const { renderShell } = require('../template');
const { publicItem } = require('../serialize');
const { isAdmin } = require('../auth');

function pageHandler(cfg, db) {
  return (req, res, params) => {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' };
    if (!isAdmin(req, cfg)) {
      res.writeHead(200, headers);
      res.end(renderShell(cfg, { locked: true }));
      return;
    }
    let status = 200;
    let initialItem = null;
    if (params && params.id) {
      const item = db.get(params.id);
      if (!item) status = 404;
      else initialItem = publicItem(db.present(item), cfg);
    }
    const html = renderShell(cfg, { initialItem, isAdmin: true, savedUI: db.store.setting('ui',{}), tracking: db.store.setting('tracking',true) });
    res.writeHead(status, headers);
    res.end(html);
  };
}

module.exports = { pageHandler };
