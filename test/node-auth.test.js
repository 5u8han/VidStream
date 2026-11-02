'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSessionCookie, clearSessionCookie, getRole } = require('../lib/auth');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

function cookie(cfg) {
  let value;
  setSessionCookie({ setHeader(name, data) { value = data; } }, cfg, { headers: {} });
  return value.split(';')[0];
}
function role(cfg, value) { return getRole({ headers: { cookie: value } }, cfg); }
const base = { adminPassword: 'fixture-passphrase', sessionSecret: 'fixture-only-secret' };

test('same-host nodes keep separate cookies and bind new tokens to their instance', () => {
  const a = { ...base, sessionCookieName: 'stream_session_node_a' };
  const b = { ...base, sessionCookieName: 'stream_session_node_b' };
  const ca = cookie(a), cb = cookie(b);
  assert.equal(role(a, ca + '; ' + cb), 'admin');
  assert.equal(role(b, ca + '; ' + cb), 'admin');
  assert.equal(role(a, cb), 'anonymous');
  assert.equal(role(b, ca), 'anonymous');
  assert.equal(role(a, cb.replace(b.sessionCookieName, a.sessionCookieName)), 'anonymous', 'Even an accidentally copied secret does not make a node-scoped token portable');
});

test('legacy sessions migrate without overriding a present instance cookie', () => {
  const legacy = cookie(base), cfg = { ...base, sessionCookieName: 'stream_session_node_a' };
  assert.equal(role(cfg, legacy), 'admin');
  assert.equal(role(cfg, legacy + '; ' + cfg.sessionCookieName + '=invalid'), 'anonymous');
  let cleared;
  clearSessionCookie({ setHeader(name, value) { cleared = value; } }, cfg);
  assert.equal(cleared.length, 2);
  assert.match(cleared[0], /^stream_session_node_a=; Max-Age=0/);
  assert.match(cleared[1], /^stream_session=; Max-Age=0/);
  assert.ok(cleared.every(value => !value.includes('node_b')));
});

test('malformed cookies from another application cannot crash node authentication', () => {
  const cfg = { ...base, sessionCookieName: 'stream_session_node_a' };
  assert.equal(role(cfg, 'other=%E0%A4%A; ' + cookie(cfg)), 'admin');
  assert.equal(role(cfg, cfg.sessionCookieName + '=%E0%A4%A'), 'anonymous');
});

test('only successful first owner setup starts configured node discovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-node-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = { dataDir: directory, sessionSecret: 'owner-setup-test-secret' };
  require('../lib/security').initializeSecurity(cfg);
  const code = cfg.setupCode;
  let starts = 0;
  const handler = require('../lib/handlers/auth').setupHandler(cfg, { onSetup: () => { starts++; } });
  async function invoke(value) {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]); req.headers = {};
    let status;
    await handler(req, { setHeader() {}, writeHead(code) { status = code; }, end() {} });
    return status;
  }
  assert.equal(await invoke({ username: 'owner', password: 'fixture-owner-passphrase', code: 'incorrect-code' }), 400);
  assert.equal(starts, 0);
  assert.equal(cfg.setupRequired, true);
  assert.equal(await invoke({ username: 'owner', password: 'fixture-owner-passphrase', code }), 200);
  assert.equal(starts, 1);
  assert.equal(cfg.setupRequired, false);
  assert.equal(await invoke({ username: 'owner', password: 'fixture-owner-passphrase', code }), 409);
  assert.equal(starts, 1);
});
