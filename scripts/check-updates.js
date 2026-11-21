'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const url = new URL(process.env.VIDSTREAM_TEST_URL);
  assert.equal(url.hostname, '127.0.0.1', 'Use an isolated loopback test server');
  const password = process.env.VIDSTREAM_TEST_PASSWORD;
  const directory = process.env.VIDSTREAM_TEST_MAILBOX;
  assert(password && directory, 'Provide a temporary test password and empty test mailbox');
  assert.deepEqual(await fs.readdir(directory), []);
  const requestFile = path.join(directory, 'request.json');
  const http = (pathname, options = {}) => fetch(new URL(pathname, url), {
    signal: AbortSignal.timeout(8000), ...options,
  });
  const statusPath = '/api/updates';
  const applyPath = statusPath + '/apply';
  assert.equal((await http(statusPath)).status, 401);
  const login = await http('/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.origin }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (endpoint, origin = url.origin) => http(endpoint, { method: 'POST',
    headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } });
  const installed = '1'.repeat(40);
  const target = '2'.repeat(40);
  async function report(state, targetRevision, extra = {}) {
    const draft = path.join(directory, 'status.tmp');
    await fs.writeFile(draft, JSON.stringify({ state, heartbeatAt: new Date().toISOString(),
      currentRevision: installed, targetRevision, ...extra }));
    await fs.rename(draft, path.join(directory, 'status.json'));
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await http(statusPath, { headers: { Cookie: cookie } });
      const observed = await response.json();
      if (observed.state === state && observed.targetRevision === targetRevision) return;
      await delay(100);
    }
    assert.fail('The server did not observe helper state ' + state);
  }
  assert.equal((await post(applyPath)).status, 409);
  await report('current', installed);
  assert.equal((await post(applyPath, 'https://example.invalid')).status, 403);
  assert.equal((await post(applyPath, '')).status, 403);
  const same = await post(applyPath);
  assert.equal(same.status, 200);
  assert.equal((await same.json()).state, 'current');
  await assert.rejects(fs.access(requestFile), { code: 'ENOENT' });
  await report('available', target);
  const apply = await post(applyPath);
  const pending = await apply.json();
  assert.equal(apply.status, 200, pending.error);
  assert.equal(pending.state, 'updating');
  assert.deepEqual(JSON.parse(await fs.readFile(requestFile, 'utf8')), { action: 'update', id: pending.requestId });
  assert.equal((await post(applyPath)).status, 409);
  await fs.unlink(requestFile);
  await report('completed', target, { id: pending.requestId, currentRevision: target });
  const completed = await (await http(statusPath, { headers: { Cookie: cookie } })).json();
  assert.equal(completed.currentRevision, target);
  assert.equal(completed.canUpdate, false);
  console.log('Update access checks, same-revision skip, single pending request and completed revision passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
