'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

test('real server SIGTERM checkpoints cache, restart restores it, and cold start keeps durable state', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstream-cache-server-'));
  const cfg = { media: path.join(directory, 'media'), cache: path.join(directory, 'ram'),
    data: path.join(directory, 'data'), snapshot: path.join(directory, 'snapshot'), originals: path.join(directory, 'originals') };
  await fs.mkdir(cfg.media);
  const children = [];
  t.after(async () => {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); await entry.exited; }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function start(cold = false) {
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MEDIA_DIR: cfg.media, CACHE_DIR: cfg.cache,
        DATA_DIR: cfg.data, ORIGINALS_DIR: cfg.originals, CACHE_SNAPSHOT_DIR: cfg.snapshot, CACHE_COLD_START: cold ? '1' : '0',
        ADMIN_PASSWORD: 'temporary-fixture-passphrase', NODE_DISCOVERY: '0', WATCH_FOR_CHANGES: '0', RESCAN_INTERVAL_MINUTES: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit'), entry = { child, exited, output: () => output }; children.push(entry);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try { if ((await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) })).ok) return entry; }
      catch {} await delay(50);
    }
    throw Error('Test server did not become healthy: ' + output);
  }
  async function stop(entry) {
    entry.child.kill('SIGTERM'); const [code, signal] = await entry.exited;
    assert.equal(code, 0, entry.output()); assert.equal(signal, null, entry.output());
  }
  const first = await start();
  const preview = path.join(cfg.cache, 'preview', 'test.mp4'); await fs.mkdir(path.dirname(preview), { recursive: true });
  await fs.writeFile(preview, 'generated preview fixture');
  const secret = await fs.readFile(path.join(cfg.data, 'session-secret'), 'utf8');
  await stop(first);
  assert.match(first.output(), /RAM cache: saved/);
  await fs.access(path.join(cfg.snapshot, 'current.json'));
  // Deleting this temporary directory simulates losing Docker tmpfs on restart.
  await fs.rm(cfg.cache, { recursive: true });
  const second = await start();
  assert.equal(await fs.readFile(preview, 'utf8'), 'generated preview fixture');
  assert.match(second.output(), /RAM cache: restored/);
  await stop(second);
  await fs.rm(cfg.cache, { recursive: true });
  const third = await start(true);
  await assert.rejects(fs.access(preview), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(cfg.data, 'session-secret'), 'utf8'), secret);
  await fs.access(path.join(cfg.data, 'library.sqlite'));
  await stop(third);
});
