'use strict';
const assert = require('node:assert/strict');
const { suggestions, sanitize } = require('../public/benchmark');

async function main() {
  const url = new URL(process.env.VIDSTREAM_TEST_URL || 'http://127.0.0.1:4000');
  assert.equal(url.hostname, '127.0.0.1', 'Use an isolated loopback test server');
  const password = process.env.VIDSTREAM_TEST_PASSWORD;
  assert(password, 'Set the temporary test server passphrase');
  const network = '/api/benchmark/network';
  const host = '/api/benchmark/host';
  const http = (path, options = {}) => fetch(new URL(path, url), { signal: AbortSignal.timeout(20_000), ...options });

  assert.equal((await http(network)).status, 401);
  assert.equal((await http(host, { method: 'POST' })).status, 401);
  const login = await http('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: url.origin };
  assert.equal((await http(network + '?probe=1', { headers })).status, 204);
  const download = await http(network, { headers });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('cache-control'), /private.*no-store/);
  assert.equal((await download.arrayBuffer()).byteLength, 4 * 1024 ** 2);
  assert.equal((await http(host, { method: 'POST', headers: { ...headers, Origin: 'http://example.invalid' } })).status, 403);
  const result = await http(host, { method: 'POST', headers });
  assert.equal(result.status, 200);
  const report = await result.json();
  assert.equal(report.schemaVersion, 1);
  assert(report.host.effectiveCores > 0);
  assert(report.host.effectiveMemoryBytes > 0);
  assert(report.cpu.iterations > 0);
  assert(report.cache.freeBytes > 0);
  assert.equal(report.cache.sampleBytes, 16 * 1024 ** 2);
  assert(report.cache.writeMiBps > 0);
  assert(report.cache.warmReadMiBps > 0);
  const fast = suggestions(report, { downloadMbps: 300, medianLatencyMs: 3 });
  const slow = suggestions(report, { downloadMbps: 2, medianLatencyMs: 300 });
  assert(fast.concurrentOptimizedPreviews >= 8);
  assert(slow.pauseAutoplay);
  const fabricated = { ...report, library: { indexedCount: 10, folders: [{ name: 'private-fixture', count: 10 }] } };
  const exportData = sanitize({ host: fabricated, advice: fast, unavailable: [] });
  assert(!JSON.stringify(exportData).includes('private-fixture'));
  assert.equal(exportData.library.folders[0].indexedItems, 10);
  console.log('Benchmark authentication, measurements, connection guidance, and JSON privacy passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
