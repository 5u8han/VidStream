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

test('server starts, serves health, and shuts down cleanly', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-startup-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
      MEDIA_DIR: media, CACHE_DIR: path.join(dir, 'cache'), DATA_DIR:path.join(dir,'data'), ORIGINALS_DIR:path.join(dir,'originals'),
      RESCAN_INTERVAL_MINUTES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  try {
    let response;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        break;
      } catch { await delay(50); }
    }
    assert.ok(response, `Server did not become healthy: ${output}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, output);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
