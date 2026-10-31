'use strict';
const { isAdmin } = require('../auth');
const { readJsonBody } = require('../body');
const { publicItem } = require('../serialize');
function json(res, code, data) { res.writeHead(code, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
function libraryHandlers(cfg, db, editor) {
  function itemFor(req, res, params) {
    if (!isAdmin(req,cfg)) { json(res,403,{error:'Admin access required'}); return null; }
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site') { json(res,415,{error:'Same-origin JSON request required'}); return null; }
    const item = db.get(params.id);
    if (!item) { json(res,404,{error:'Media not found'}); return null; }
    return item;
  }
  return {
    preferences: async (req,res,params) => {
      const item = itemFor(req,res,params); if (!item) return;
      try {
        const body = await readJsonBody(req), changes = {};
        for (const key of ['favorite','pinned','bookmarked']) if (body[key] !== undefined) {
          if (typeof body[key] !== 'boolean') throw Error(key + ' must be true or false');
          changes[key] = body[key];
        }
        if (body.creatorAlias !== undefined) {
          if (typeof body.creatorAlias !== 'string' || body.creatorAlias.length > 120 || /[\u0000-\u001f]/.test(body.creatorAlias)) throw Error('Artist label must contain at most 120 printable characters');
          changes.creatorAlias = body.creatorAlias.trim() || null;
        }
        if (!Object.keys(changes).length) throw Error('Choose a favorite, pin, bookmark, or artist label value');
        db.store.update(item, changes);
        json(res,200,{item:publicItem(item,cfg,true)});
      } catch (err) { json(res,400,{error:err.message}); }
    },
    edit: async (req,res,params) => {
      const item = itemFor(req,res,params); if (!item) return;
      try { json(res,200,await editor.edit(item,await readJsonBody(req))); }
      catch (err) { json(res,400,{error:err.message}); }
    },
  };
}
module.exports = { libraryHandlers };
