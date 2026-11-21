#!/usr/bin/env node
'use strict';
const http = require('http');
const path = require('path');
const { URL } = require('url');

const { loadConfig } = require('./lib/config');
const { Db } = require('./lib/db');
const { AiManager } = require('./lib/ai-manager');
const { Scanner, scannerWorkerCount } = require('./lib/scanner');
const { Router } = require('./lib/router');
const { serveFile } = require('./lib/serve-file');
const { isAdmin, hasSameOrigin } = require('./lib/auth');
const { renderShell } = require('./lib/template');

const { pageHandler } = require('./lib/handlers/page');
const { mediaHandler } = require('./lib/handlers/media');
const {
  itemsHandler, itemHandler, rescanHandler, scanControlHandler, skipScanFileHandler, healthHandler, libraryStatusHandler, readyPreviewsHandler,
  duplicatesHandler, dashboardHandler, dashboardFilesHandler, diagnosticsHandlers, aiStatusHandler, aiUpdateHandler, aiInstallHandler,
} = require('./lib/handlers/api');
const { loginHandler, logoutHandler, setupHandler } = require('./lib/handlers/auth');

async function boot() {
const ROOT = __dirname;
const cfg = loadConfig(ROOT);
const cacheRuntime = new (require('./lib/cache-runtime').CacheRuntime)(cfg, { log: message => console.log('[stream] ' + message) });
await cacheRuntime.restore();
require('./lib/security').initializeSecurity(cfg);
const ai = new AiManager(cfg);

const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir, { mediaFolders: cfg.mediaFolders });
const diagnostics = new (require('./lib/diagnostics').Diagnostics)(db.store);
const onIssue = issue => diagnostics.record(issue);
const nodes = new (require('./lib/node-manager').NodeManager)(cfg, db.store, { onIssue });
cfg.sessionCookieName = 'stream_session_' + nodes.id.replace(/-/g, '');
Object.defineProperty(cfg, 'node', { get: () => ({ id: nodes.id, name: nodes.descriptor().name }) });
Object.defineProperty(cfg, 'role', { get: () => nodes.settings.role });
const nodeHandlers = require('./lib/handlers/nodes').nodesHandlers(cfg, nodes);
const coordinator = new (require('./lib/work-coordinator').WorkCoordinator)(db.store, { scanWorkers: scannerWorkerCount(cfg), onIssue });
const derivativeCache = cfg.derivativeCache = new (require('./lib/derivative-cache').DerivativeCache)(cfg, db, coordinator, {
  log: message => {
    console.log('[stream] ' + message);
    if (/failed|could not|disabled/i.test(message))
      onIssue({ code: 'DERIVATIVE_CACHE_WARNING', message });
  },
});
await derivativeCache.validate();
const sourceReadCache = cfg.sourceReadCache = new (require('./lib/source-read-cache').SourceReadCache)(cfg, {
  log: message => {
    console.log('[stream] ' + message);
    onIssue({ code: 'SOURCE_CACHE_UNAVAILABLE', message });
  },
});
await sourceReadCache.initialize();
const scanner = new Scanner(cfg, db, {
  coordinator, onIssue,
  onLog: (msg) => console.log(`[stream] ${msg}`),
});
const schedule = new (require('./lib/scan-schedule').ScanSchedule)(cfg, db.store, scanner);

const { MediaEditor } = require('./lib/media-editor');
const { libraryHandlers } = require('./lib/handlers/library');
const editor = new MediaEditor(cfg, db, scanner);
const library = libraryHandlers(cfg, db, {edit:(item,body)=>coordinator.run('edit',item.filename,()=>editor.edit(item,body),{heavy:true,priority:20,path:item.relPath})});
const { settingsHandlers } = require('./lib/handlers/settings');
const resources = new (require('./lib/resource-monitor').ResourceMonitor)(cfg,db.store);
const settings = settingsHandlers(cfg, db, schedule);
const folders = require('./lib/handlers/folders').folderCollectionsHandlers(cfg, db);
const maintenance = new (require('./lib/maintenance').Maintenance)(cfg,db);
const playback = new (require('./lib/playback-service').PlaybackService)(cfg,db,coordinator);
const workbench = require('./lib/handlers/workbench').workbenchHandlers(cfg,db,{maintenance,coordinator,playback,scanner});
const router = new Router();
const updates = require('./lib/app-update').updateHandlers(cfg);
router.get('/api/updates', updates.status);
router.post('/api/updates/check', updates.check);
router.post('/api/updates/apply', updates.apply);
router.get('/api/folders', folders.get);
router.post('/api/folders', folders.update);
router.get('/api/node-info', nodeHandlers.info);
router.get('/api/nodes', nodeHandlers.list);
router.post('/api/nodes/settings', nodeHandlers.settings);
router.post('/api/nodes/probe', nodeHandlers.probe);
router.post('/api/nodes/add', nodeHandlers.add);
router.post('/api/nodes/remove', nodeHandlers.remove);
router.post('/api/nodes/refresh', nodeHandlers.refresh);
router.get('/api/work',workbench.status);
router.post('/api/work/preset',workbench.preset);
router.post('/api/items/:id/relink',workbench.relink);
router.post('/api/items/:id/playback',workbench.playback);
router.get('/api/items/:id/playback/video',workbench.playbackFile);
router.get('/api/maintenance/storage',workbench.storage);
router.post('/api/maintenance/backup',workbench.backup);
router.get('/api/maintenance/backup/:name',workbench.backupFile);
router.post('/api/maintenance/retention',workbench.retention);
router.get('/api/settings', settings.get);
router.get('/api/settings/scanning', settings.scanning);
router.get('/api/library-map',require('./lib/handlers/library-map').libraryMapHandler(cfg,db));
router.get('/api/resources', async(req,res)=>{if(!isAdmin(req,cfg)){res.writeHead(403);return res.end();}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(await resources.sample()));});
router.post('/api/settings', settings.update);
router.post('/api/settings/scanning', settings.updateScanning);
router.post('/api/activity', settings.events);
router.get('/api/activity', settings.activity);
router.post('/api/items/:id/resume', settings.resume);
router.post('/api/items/:id/preferences', library.preferences);
router.post('/api/items/:id/edit', library.edit);
router.get('/health', healthHandler(cfg));
router.post('/api/setup', setupHandler(cfg, { onSetup: () => nodes.restartDiscovery() }));
router.post('/api/login', loginHandler(cfg));
router.post('/api/logout', logoutHandler(cfg));
router.get('/api/items', itemsHandler(cfg, db));
router.get('/api/ready-previews', readyPreviewsHandler(cfg, db));
router.get('/api/item/:id', itemHandler(cfg, db));
router.get('/api/library-status', libraryStatusHandler(cfg, scanner));
router.get('/api/dashboard', dashboardHandler(cfg, db, scanner));
const benchmark = require('./lib/benchmark').benchmarkHandlers(cfg, db, scanner);
router.post('/api/benchmark/host', benchmark.host);
router.get('/api/benchmark/network', benchmark.network);
const notifications = diagnosticsHandlers(cfg, db, diagnostics, scanner, playback);
router.get('/api/notifications', notifications.get);
router.get('/api/notifications/recovery', notifications.recoveryList);
router.get('/api/notifications/:id/source', notifications.recoverySource);
router.post('/api/notifications/read', notifications.read);
router.get('/api/notifications/:id/repair', notifications.repairStatus);
router.post('/api/notifications/:id/repair', notifications.repair);
router.get('/api/dashboard/files', dashboardFilesHandler(cfg, db));
router.get('/api/ai', aiStatusHandler(cfg, ai));
router.post('/api/ai', aiUpdateHandler(cfg, ai));
router.post('/api/ai/install', aiInstallHandler(cfg, ai));
router.get('/api/duplicates', duplicatesHandler(cfg, db));
router.post('/api/rescan', rescanHandler(cfg, db, scanner));
router.post('/api/scan-control', scanControlHandler(cfg, scanner));
router.post('/api/scan-control/skip', skipScanFileHandler(cfg, scanner));
router.get('/media/:id/:variant', mediaHandler(cfg, db));
router.get('/', pageHandler(cfg, db));
router.get('/:id', pageHandler(cfg, db));

const STATIC_ASSETS = new Set(['/app.js', '/ambient.js', '/styles.css', '/design.css', '/entrance.js', '/nodes.js', '/nodes.css', '/folders.js', '/folders.css', '/social-preview.png', '/settings.js', '/activity.js', '/resources.js', '/library-layout.js', '/artist-outlines.js', '/library-map.js', '/player-stats.js', '/navigation.js', '/preview-controller.js', '/preview-memory.js', '/diagnostics.js', '/benchmark.js', '/benchmark.css', '/dashboard-notifications.js', '/dashboard-notifications.css', '/library-tools.js', '/controls.css', '/options.css']);
const PUBLIC_DIR = path.join(ROOT, 'public');

const requests = new Set();
const server = http.createServer((req, res) => {
  if (shuttingDown) { res.writeHead(503, { Connection: 'close' }); res.end('Server is stopping'); return; }
  const request = handleRequest(req, res);
  requests.add(request);
  request.finally(() => requests.delete(request)).catch(() => {});
});

async function handleRequest(req, res) {
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
    return serveFile(req, res, path.join(PUBLIC_DIR, pathname));
  }

  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'POST' && (req.headers['sec-fetch-site'] === 'cross-site' || !hasSameOrigin(req, cfg))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Same-origin request required' }));
    return;
  }

  const publicRead = req.method === 'GET' && (pathname === '/health' || pathname === '/api/node-info');
  const publicAuth = req.method === 'POST' && ['/api/login', '/api/setup', '/api/logout'].includes(pathname);
  if (!publicRead && !publicAuth && !isAdmin(req, cfg)) {
    if (req.method !== 'GET' || pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sign-in required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderShell(cfg, { locked: true }));
    return;
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
    if (isAdmin(req, cfg) && !pathname.startsWith('/api/notifications')) {
      const item = match.params?.id ? db.get(match.params.id) : null;
      diagnostics.record({ level: 'error', code: 'REQUEST_FAILED', path: item?.relPath,
        message: (err.code || 'Unexpected error') + ' while processing ' + req.method + ' request.' });
    }
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

async function main() {
  if (cfg.setupRequired) {
    if (cfg.dockerRuntime && !cfg.setupHelperUsed) {
      console.log('[stream] Try Start-Here.sh or Start-Here.bat from the checkout to select media folders and a starting theme. For manual Compose, configure media mounts before browsing.');
    }
    console.log('[stream] Owner setup code: ' + cfg.setupCode + ' (enter this once in the web setup screen)');
  }
  resources.start();
  diagnostics.start(scanner, coordinator, cfg);
  derivativeCache.start();
  console.log(`[stream] Media folder: ${cfg.mediaDir}`);

  const scanOnStart = schedule.settings().effective.scanOnStart;
  server.listen(cfg.port, cfg.host, async () => {
    console.log(`[stream] ${cfg.title} listening on http://${cfg.host}:${cfg.port}`);
    nodes.start();
    if (!scanOnStart && await scanner.hasSavedScan()) {
      console.log('[stream] Serving the saved catalog without a startup scan.');
      schedule.start();
      return;
    }
    console.log(scanOnStart ? '[stream] Startup scan requested by scan settings.'
      : '[stream] No matching completed catalog for these mounts. Scanning in the background...');
    scanner.scan()
      .catch((err) => console.error('[stream] Initial scan failed:', err))
      .finally(() => schedule.start());
  });
}

main().catch((err) => {
  console.error('[stream] Fatal startup error:', err);
  process.exit(1);
});

let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;
  resources.stop();schedule.stop();scanner.stopWatching();
  await derivativeCache.stop();
  ai.stop();
  await nodes.stop();
  const stopped=coordinator.stop();
  const closed=new Promise(resolve=>server.close(resolve));
  server.closeAllConnections();
  await Promise.allSettled([...requests]);
  await sourceReadCache.stop();
  await scanner.waitForIdle();await stopped;await closed;
  require('./lib/vision-objects').shutdown();
  diagnostics.stop();
  db.close ? db.close() : db.store.close();
  await cacheRuntime.save();
  process.exit(0);
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown().catch(err=>{console.error('[stream] Shutdown error:',err.message);process.exit(1);}));

}

boot().catch(error => { console.error('[stream] Fatal startup error:', error.message); process.exit(1); });
