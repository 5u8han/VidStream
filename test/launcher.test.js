'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { NativeLauncher, nodeSupported, validateConfig, cleanLog } = require('../scripts/vidstream-launcher');

test('native launcher checks runtime versions, separates paths, and redacts credential-like logs', () => {
  assert.equal(nodeSupported('22.12.0'), false); assert.equal(nodeSupported('22.13.0'), true); assert.equal(nodeSupported('24.0.0'), true);
  const config = { mediaDir: '/photos', dataDir: '/data', cacheDir: '/cache', port: 4000, allowLan: false };
  assert.throws(() => validateConfig({ ...config, cacheDir: '/photos/previews' }, config), /separate/);
  assert.throws(() => validateConfig({ ...config, originalsDir: '/photos/archived' }, config), /separate/);
  assert.throws(() => validateConfig({ ...config, mediaDir: 'relative' }, config), /absolute/);
  assert.throws(() => validateConfig({ ...config, port: 10 }, config), /1024/);
  assert.equal(cleanLog('ADMIN_PASSWORD=secret token:private'), 'ADMIN_PASSWORD=[redacted] token=[redacted]');
});

test('native launcher remains local, starts/stops one child, and preserves configured folders', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstream-launcher-'));
  const media = path.join(dir, 'media'), data = path.join(dir, 'data'), cache = path.join(dir, 'cache');
  await fs.mkdir(media); await fs.writeFile(path.join(media, 'keep.txt'), 'source');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const appPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let spawned = 0, spawnOptions;
  function spawnChild(_executable, _args, options) {
    spawned++; spawnOptions = options;
    const child = new EventEmitter(); child.pid = process.pid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { queueMicrotask(() => child.emit('close', 0, signal)); return true; };
    setTimeout(() => child.stdout.write('[stream] Stream listening on http://127.0.0.1:' + appPort + '\n'), 5);
    return child;
  }
  const launcher = new NativeLauncher({ dataDir: data, spawnChild, probe: () => [{ name: 'ffmpeg', available: true }] });
  const base = await launcher.listen();
  t.after(async () => { await launcher.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const status = await (await fetch(base + '/api/status')).json();
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('Start server'));
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  assert.equal(status.state, 'stopped'); assert.equal(launcher.server.address().address, '127.0.0.1');
  const forbidden = await fetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://another.example' }, body: '{}' });
  assert.equal(forbidden.status, 403); assert.equal(spawned, 0);
  const tooLarge = await fetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: ' '.repeat(2049) });
  assert.equal(tooLarge.status, 413);
  async function post(route, body) { return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }); }
  const started = await post('/api/start', { mediaDir: media, dataDir: data, cacheDir: cache, port: appPort, allowLan: false });
  assert.equal(started.status, 200, await started.text()); assert.equal(spawned, 1);
  assert.equal(spawnOptions.env.DATA_DIR, data); assert.equal(spawnOptions.env.HOST, '127.0.0.1');
  assert.equal(spawnOptions.env.ORIGINALS_DIR, path.join(data, 'originals', 'original'));
  assert.equal((await post('/api/start', {})).status, 400);
  const stopped = await post('/api/stop', {}); assert.equal(stopped.status, 200); assert.equal(launcher.status().state, 'stopped');
  assert.equal(await fs.readFile(path.join(media, 'keep.txt'), 'utf8'), 'source');
  const again = new NativeLauncher({ dataDir: data, probe: () => [] }); await again.load();
  assert.equal(again.config.mediaDir, media); assert.equal(again.config.cacheDir, cache);
});
