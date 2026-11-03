'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { Db } = require('../lib/db');

const REMOVED_ROUTES = [
  ['POST', '/api/items/legacy/enhance-estimate'],
  ['GET', '/api/items/legacy/variants'],
  ['POST', '/api/items/legacy/variants'],
  ['POST', '/api/maintenance/recover'],
  ['POST', '/api/enhancement-runtime/install'],
  ['POST', '/api/enhancements/batch'],
  ['POST', '/api/clean-library/export'],
  ['GET', '/api/clean-library'],
  ['GET', '/api/enhancements'],
  ['POST', '/api/items/legacy/enhance'],
  ['POST', '/api/enhancements/legacy-job'],
  ['GET', '/api/enhancements/legacy-job/video'],
  ['POST', '/api/enhancement-models/install']
];

function retiredRecords(file) {
  const sql = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      jobs: sql.prepare('SELECT id,data FROM enhancement_jobs ORDER BY id').all(),
      tasks: sql.prepare('SELECT id,data FROM work_tasks ORDER BY id').all(),
      enabled: sql.prepare("SELECT value FROM settings WHERE key='enhancementEnabled'").get().value
    };
  } finally { sql.close(); }
}

test('hosting startup leaves retired work and files inert, removes its APIs and rejects re-enabling it', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-hosting-only-'));
  const dataDir = path.join(root, 'data'), cacheDir = path.join(root, 'cache');
  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(mediaDir);
  // A temporary entrypoint avoids reading any developer installation's .env.
  fs.copyFileSync(path.resolve(__dirname, '../server.js'), path.join(root, 'server.js'));
  fs.symlinkSync(path.resolve(__dirname, '../lib'), path.join(root, 'lib'), 'dir');
  const db = new Db(path.join(cacheDir, 'index.json'), dataDir);
  db.store.saveJob({ id: 'legacy-job', itemId: 'legacy', relPath: 'legacy.mp4',
    state: 'queued', sourceFingerprint: 'old-source', options: { smoothing: 'ffmpeg', fps: 60 } });
  db.store.setSetting('enhancementEnabled', false);
  db.store.sql.exec('CREATE TABLE IF NOT EXISTS work_tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  for (const kind of ['enhancement', 'export', 'publish', 'restore', 'recovery']) {
    const task = { id: 'retired-' + kind, kind, state: 'running', label: 'Retained old work',
      updatedAt: '2026-01-01T00:00:00.000Z' };
    db.store.sql.prepare('INSERT INTO work_tasks VALUES(?,?)').run(task.id, JSON.stringify(task));
  }
  const databaseFile = path.join(dataDir, 'library.sqlite');
  clearTimeout(db._saveTimer); db.store.close();
  const originalRecords = retiredRecords(databaseFile);
  const outputFile = path.join(dataDir, 'enhancements', 'legacy-job', 'enhanced.mp4');
  const outputBytes = Buffer.from('retained result bytes are never served, deleted, or replaced');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, outputBytes);
  const outputStat = fs.statSync(outputFile);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MEDIA_DIR: mediaDir,
      CACHE_DIR: cacheDir, DATA_DIR: dataDir, ORIGINALS_DIR: path.join(root, 'originals'),
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'hosting-fixture-password', SITE_PASSWORD: '',
      LDAP_URL: '', SESSION_SECRET: 'hosting-only-test-session-secret', REQUIRE_LOGIN: '1',
      NODE_DISCOVERY: '0', NODE_URL: '', WATCH_FOR_CHANGES: '0', RESCAN_INTERVAL_MINUTES: '0',
      ENABLE_FACE_DETECTION: '0', ENABLE_PET_DETECTION: '0', ENABLE_OCR: '0',
      ENABLE_DUPLICATE_DETECTION: '0', ENABLE_OBJECT_DETECTION: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, log);
      try {
        healthy = (await fetch(origin + '/health', { signal: AbortSignal.timeout(250) })).ok;
        if (healthy) break;
      } catch { /* the temporary server may still be starting */ }
      await delay(50);
    }
    assert.equal(healthy, true, log);
    const login = await fetch(origin + '/api/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'owner', password: 'hosting-fixture-password' }) });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin };
    const settingsResponse = await fetch(origin + '/api/settings', { headers });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.deepEqual(Object.keys(settings).sort(), ['security', 'tracking', 'ui']);
    assert.equal(settings.security.requireLogin, true);
    for (const [method, route] of REMOVED_ROUTES) {
      const response = await fetch(origin + route, { method, headers,
        ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(response.status, 404, method + ' ' + route);
      assert.equal(await response.text(), 'Not found');
    }
    for (const body of [
      { enhancementEnabled: true }, { defaults: { smoothing: 'ffmpeg' } },
      { workPreset: 'process' }, { enhancement: { enabled: true } },
      { ui: { 'stream-theme': 'light' }, tracking: false, enhancementEnabled: true }
    ]) {
      const response = await fetch(origin + '/api/settings', { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json()).error, /Unsupported settings field/);
    }
    const unchanged = await (await fetch(origin + '/api/settings', { headers })).json();
    assert.deepEqual(unchanged, settings, 'Rejected settings changes must be atomic');
    const valid = await fetch(origin + '/api/settings', { method: 'POST', headers,
      body: JSON.stringify({ tracking: false, requireLogin: true, ui: { 'stream-theme': 'light' } }) });
    assert.equal(valid.status, 200);
    const updated = await (await fetch(origin + '/api/settings', { headers })).json();
    assert.equal(updated.tracking, false);
    assert.equal(updated.ui['stream-theme'], 'light');
    const workResponse = await fetch(origin + '/api/work', { headers });
    assert.equal(workResponse.status, 200);
    const work = (await workResponse.json()).work;
    assert.deepEqual(work.active, []);
    assert.deepEqual(work.queued, []);
    assert.equal(work.recent.some(task => task.id.startsWith('retired-')), false);
    assert.deepEqual(retiredRecords(databaseFile), originalRecords);
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, log);
    assert.equal(signal, null);
    assert.deepEqual(retiredRecords(databaseFile), originalRecords);
    assert.deepEqual(fs.readFileSync(outputFile), outputBytes);
    assert.equal(fs.statSync(outputFile).mtimeMs, outputStat.mtimeMs);
    for (const folder of ['enhancement-models', 'enhancement-runtime'])
      assert.equal(fs.existsSync(path.join(dataDir, folder)), false, folder + ' must not be initialized');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
