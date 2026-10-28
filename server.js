#!/usr/bin/env node
'use strict';
const http = require('http');
const path = require('path');
const { URL } = require('url');

const { loadConfig } = require('./lib/config');
const { Db } = require('./lib/db');
const { AiManager } = require('./lib/ai-manager');
const { Scanner } = require('./lib/scanner');
const { Router } = require('./lib/router');
const { serveFile } = require('./lib/serve-file');
const { isAdmin, authConfigured } = require('./lib/auth');
const { renderShell } = require('./lib/template');

const { pageHandler } = require('./lib/handlers/page');
const { mediaHandler } = require('./lib/handlers/media');
const {
  itemsHandler, itemHandler, rescanHandler, healthHandler, libraryStatusHandler,
  setItemVisibilityHandler, setAlbumVisibilityHandler, duplicatesHandler, dashboardHandler, dashboardFilesHandler, aiStatusHandler, aiUpdateHandler, aiInstallHandler,
} = require('./lib/handlers/api');
const { feedHandler } = require('./lib/feed');
const { loginHandler, logoutHandler, setupHandler } = require('./lib/handlers/auth');
const { downloadZipHandler } = require('./lib/handlers/download');

const ROOT = __dirname;
const cfg = loadConfig(ROOT);
require('./lib/security').initializeSecurity(cfg);
const ai = new AiManager(cfg);

const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir);
if(!cfg.setupRequired)cfg.requireLogin=db.store.setting('requireLogin',cfg.requireLogin);
const scanner = new Scanner(cfg, db, {
  onLog: (msg) => console.log(`[stream] ${msg}`),
});

const { MediaEditor } = require('./lib/media-editor');
const { libraryHandlers } = require('./lib/handlers/library');
const library = libraryHandlers(cfg, db, new MediaEditor(cfg, db, scanner));
const { EnhancementQueue } = require('./lib/enhancement-queue');
const { settingsHandlers } = require('./lib/handlers/settings');
const enhancements = new EnhancementQueue(cfg, db);
const cleanLibrary = new (require('./lib/clean-library').CleanLibrary)(cfg,db,enhancements);
const resources = new (require('./lib/resource-monitor').ResourceMonitor)(cfg,db.store);
const settings = settingsHandlers(cfg, db, enhancements, ai, cleanLibrary);
const router = new Router();
router.get('/api/settings', settings.get);
router.get('/api/resources', async(req,res)=>{if(!isAdmin(req,cfg)){res.writeHead(403);return res.end();}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(await resources.sample()));});
router.post('/api/enhancement-runtime/install', settings.runtime);
router.post('/api/enhancements/batch', settings.batch);
router.post('/api/clean-library/export', settings.export);
router.get('/api/clean-library', settings.exportStatus);
router.post('/api/settings', settings.update);
router.post('/api/activity', settings.events);
router.get('/api/activity', settings.activity);
router.get('/api/enhancements', settings.jobs);
router.post('/api/items/:id/enhance', settings.create);
router.post('/api/enhancements/:id', settings.control);
router.get('/api/enhancements/:id/video', settings.video);
router.post('/api/enhancement-models/install', settings.install);
router.post('/api/items/:id/preferences', library.preferences);
router.post('/api/items/:id/edit', library.edit);
router.get('/health', healthHandler(cfg, db));
router.get('/feed.xml', feedHandler(cfg, db));
router.post('/api/setup', setupHandler(cfg));
router.post('/api/login', loginHandler(cfg));
router.post('/api/logout', logoutHandler());
router.get('/api/items', itemsHandler(cfg, db));
router.get('/api/item/:id', itemHandler(cfg, db));
router.get('/api/library-status', libraryStatusHandler(cfg, scanner));
router.get('/api/dashboard', dashboardHandler(cfg, db, scanner));
router.get('/api/dashboard/files', dashboardFilesHandler(cfg, db));
router.get('/api/ai', aiStatusHandler(cfg, ai));
router.post('/api/ai', aiUpdateHandler(cfg, ai));
router.post('/api/ai/install', aiInstallHandler(cfg, ai));
router.post('/api/items/:id/visibility', setItemVisibilityHandler(cfg, db));
router.post('/api/albums/visibility', setAlbumVisibilityHandler(cfg, db));
router.get('/api/duplicates', duplicatesHandler(cfg, db));
router.post('/api/download-zip', downloadZipHandler(cfg, db));
router.post('/api/rescan', rescanHandler(cfg, db, scanner));
router.get('/media/:id/:variant', mediaHandler(cfg, db));
router.get('/', pageHandler(cfg, db));
router.get('/:id', pageHandler(cfg, db));

const STATIC_ASSETS = new Set(['/app.js', '/ambient.js', '/styles.css', '/social-preview.png', '/settings.js', '/activity.js', '/resources.js']);
const PUBLIC_DIR = path.join(ROOT, 'public');

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (STATIC_ASSETS.has(pathname)) {
    serveFile(req, res, path.join(PUBLIC_DIR, pathname), { cacheForever: false });
    return;
  }

  if(req.method==='POST' && (req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin && req.headers.origin!==((req.headers['x-forwarded-proto']==='https'?'https':'http')+'://'+req.headers.host)))) {
    res.writeHead(403, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'Same-origin request required'}));return;
  }

  // REQUIRE_LOGIN: signed-out visitors can reach only the login endpoint
  // and a login-only page shell -- no gallery UI, media, API, or feed.
  if ((cfg.setupRequired || (cfg.requireLogin && authConfigured(cfg))) && !isAdmin(req, cfg)) {
    const open = pathname === '/api/login' || pathname === '/api/setup' || pathname === '/api/logout' || pathname === '/health';
    if (!open) {
      if (pathname.startsWith('/api/') || pathname.startsWith('/media/') || pathname === '/feed.xml') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sign-in required' }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(renderShell(cfg, { locked: true }));
        return;
      }
    }
  }

  const match = router.match(req.method, pathname);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  try {
    await match.handler(req, res, match.params);
  } catch (err) {
    console.error(`[stream] Error handling ${req.method} ${pathname}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

async function main() {
  if(cfg.setupRequired)console.log('[stream] Owner setup code: '+cfg.setupCode+' (enter this once in the web setup screen)');
  resources.start();
  await enhancements.start();
  console.log(`[stream] Media folder: ${cfg.mediaDir}`);
  // Serve the cached index immediately. Scanning remote SMB storage may take a
  // long time; it must never make the entire website unavailable on startup.
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[stream] ${cfg.title} listening on http://${cfg.host}:${cfg.port}`);
    console.log('[stream] Scanning in the background...');
    scanner.scan()
      .catch((err) => console.error('[stream] Initial scan failed:', err))
      .finally(() => scanner.startWatching());
  });
  if (cfg.rescanIntervalMinutes > 0) {
    setInterval(() => {
      scanner.scan().catch((err) => console.error('[stream] Interval scan failed:', err));
    }, cfg.rescanIntervalMinutes * 60 * 1000);
  }
}

main().catch((err) => {
  console.error('[stream] Fatal startup error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  resources.stop();cleanLibrary.stop();
  void enhancements.stop();
  scanner.stopWatching();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  resources.stop();cleanLibrary.stop();
  void enhancements.stop();
  scanner.stopWatching();
  server.close(() => process.exit(0));
});
