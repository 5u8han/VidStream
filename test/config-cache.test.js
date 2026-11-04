'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-cache-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), data = path.join(root, 'data');
  fs.mkdirSync(cache); fs.mkdirSync(data);
  function load(extra = {}) {
    return JSON.parse(execFileSync(process.execPath, ['-e',
      'const cfg=require(process.argv[1]).loadConfig(process.argv[2]); console.log(JSON.stringify({secret:cfg.sessionSecret,data:cfg.dataDir,snapshot:cfg.cacheSnapshotDir,cold:cfg.cacheColdStart}));',
      path.resolve(__dirname, '../lib/config.js'), root], {
      env: { PATH: process.env.PATH, CACHE_DIR: cache, DATA_DIR: data, ...extra }, encoding: 'utf8'
    }));
  }
  return { root, cache, data, load };
}

test('moving the session key from legacy cache preserves sessions when previews are cleared', t => {
  const f = fixture(t), secret = 'legacy-cache-session-key-preserved-123456789';
  fs.writeFileSync(path.join(f.cache, 'session-secret'), secret);
  assert.equal(f.load().secret, secret);
  assert.equal(fs.readFileSync(path.join(f.data, 'session-secret'), 'utf8'), secret);
  fs.rmSync(f.cache, { recursive: true });
  assert.equal(f.load().secret, secret);
});

test('first RAM enable preserves a legacy session key in the relocated cache volume', t => {
  const f = fixture(t), persisted = path.join(f.root, 'cache-volume'); fs.mkdirSync(persisted);
  const secret = 'legacy-volume-session-key-preserved-123456789';
  fs.writeFileSync(path.join(persisted, 'session-secret'), secret);
  const cfg = f.load({ CACHE_SNAPSHOT_DIR: path.join(persisted, '.ram-cache'), CACHE_COLD_START: '1' });
  assert.equal(cfg.secret, secret);
  assert.equal(cfg.cold, true);
  assert.equal(fs.readFileSync(path.join(f.data, 'session-secret'), 'utf8'), secret);
});

test('an established data key wins over stale cache copies and explicit keys retain precedence', t => {
  const f = fixture(t), first = f.load().secret;
  fs.writeFileSync(path.join(f.cache, 'session-secret'), 'stale-cache-session-secret-123456789');
  assert.equal(f.load().secret, first);
  assert.equal(f.load({ SESSION_SECRET: 'explicit-session-secret-123456789' }).secret, 'explicit-session-secret-123456789');
  assert.equal(fs.statSync(path.join(f.data, 'session-secret')).mode & 0o777, 0o600);
});
