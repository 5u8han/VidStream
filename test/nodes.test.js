'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { Readable } = require('node:stream');
const { NodeManager, MAX_PEERS } = require('../lib/node-manager');
const { LanDiscovery, GROUP, PORT, PROTOCOL } = require('../lib/node-discovery');
const { normalizeNodeUrl, isAllowedAddress, fetchDescriptor } = require('../lib/node-network');
const { nodesHandlers } = require('../lib/handlers/nodes');

function memoryStore() {
  const values = new Map();
  return {
    setting(key, fallback = null) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    setSetting(key, value) { values.set(key, structuredClone(value)); },
  };
}
function descriptor(id = crypto.randomUUID(), name = 'Wedding archive') {
  return { product: 'VidStream', protocol: 1, id, name };
}
function dummyDiscovery(options) {
  return { active: false, start() { this.active = true; }, stop() { this.active = false; },
    status() { return { active: this.active, error: null, port: PORT }; }, options };
}
function manager(cfg = {}, options = {}, store = memoryStore()) {
  return new NodeManager({ title: 'Local library', ...cfg }, store, { discoveryFactory: dummyDiscovery, ...options });
}

test('node identity and saved addresses survive restart without exposing media/configuration', async () => {
  const store = memoryStore();
  const first = manager({ mediaDir: '/private/photos', sessionSecret: 'never-expose-this', adminPassword: 'secret' }, {}, store);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(first.descriptor()).sort(), ['id', 'name', 'product', 'protocol']);
  assert.equal(JSON.stringify(first.descriptor()).includes('private'), false);
  first.updateSettings({ name: 'NAS · Family', url: 'http://192.168.1.50:4000/', discoveryEnabled: false });
  const again = manager({}, {}, store);
  assert.equal(again.id, first.id);
  assert.equal(again.status().self.name, 'NAS · Family');
  assert.equal(again.status().self.url, 'http://192.168.1.50:4000');
  assert.notEqual(manager().id, first.id);
  await first.stop(); await again.stop();
});

test('clearing an advertised address persists and setup completion can start configured discovery once', async () => {
  const store = memoryStore(), cfg = { nodeUrl: 'http://192.168.1.40:4000', nodeDiscovery: true, setupRequired: true };
  const nodes = manager(cfg, {}, store);
  nodes.start(); assert.equal(nodes.status().discovery.active, false);
  nodes.cfg.setupRequired = false; nodes.restartDiscovery();
  assert.equal(nodes.status().discovery.active, true);
  nodes.updateSettings({ url: '', discoveryEnabled: false });
  const restored = manager(cfg, {}, store);
  assert.equal(restored.status().self.url, '');
  assert.equal(restored.status().self.discoveryEnabled, false);
  await nodes.stop(); await restored.stop();
});

test('node addresses are root HTTP(S) origins and exclude reserved/metadata destinations', () => {
  assert.equal(normalizeNodeUrl(' http://NAS.local:4000/ '), 'http://nas.local:4000');
  assert.equal(normalizeNodeUrl('https://library.example'), 'https://library.example');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@nas:4000', 'http://nas:4000/media', 'http://nas:4000/?token=x', 'http://nas:4000/#x', 'http://nas:22', 'http://nas\\@other', 'http://metadata.google.internal'])
    assert.throws(() => normalizeNodeUrl(value), undefined, value);
  for (const address of ['10.1.2.3', '192.168.2.1', '172.31.1.5', '100.65.2.3', '127.0.0.1', '8.8.8.8', '::1', 'fd12::5', '2606:4700:4700::1111'])
    assert.equal(isAllowedAddress(address), true, address);
  for (const address of ['0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255', '100.100.100.200', '::', 'fe80::1', 'ff02::1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:a9fe:a9fe', 'fd00:ec2::254', 'fd00:0ec2:0:0:0:0:0:254'])
    assert.equal(isAllowedAddress(address), false, address);
});

test('adding nodes pins checked identity and never overwrites another address or cloned identity', async () => {
  const remote = descriptor(); let returned = remote;
  const store = memoryStore();
  const nodes = manager({}, { probe: async () => ({ ...returned, url: 'http://evil.example' }) }, store);
  await assert.rejects(nodes.add({ url: 'http://192.168.1.20:4000', expectedId: crypto.randomUUID() }), /changed/);
  assert.equal(nodes.status().peers.length, 0);
  await nodes.add({ url: 'http://192.168.1.20:4000', expectedId: remote.id });
  assert.equal(nodes.status().peers[0].url, 'http://192.168.1.20:4000');
  await assert.rejects(nodes.add({ url: 'http://192.168.1.21:4000' }), /already saved/);
  returned = descriptor();
  await assert.rejects(nodes.add({ url: 'http://192.168.1.20:4000' }), /different saved identity/);
  returned = descriptor(nodes.id);
  await assert.rejects(nodes.probe('http://192.168.1.22:4000'), /separate data directories/);
  const restored = manager({}, {}, store);
  assert.equal(restored.status().peers[0].id, remote.id);
  nodes.remove(remote.id);
  assert.equal(nodes.status().peers.length, 0);
  await nodes.stop(); await restored.stop();
});

test('refresh is bounded, preserves offline nodes, and refuses changed identities', async () => {
  const values = Array.from({ length: 8 }, (_, i) => ({ ...descriptor(), url: 'http://192.168.1.' + (20 + i) + ':4000' }));
  const store = memoryStore(); store.setSetting('nodePeers', values);
  let active = 0, peak = 0;
  const nodes = manager({}, { probe: async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    if (url === values[0].url) throw Error('Asleep');
    if (url === values[1].url) return descriptor();
    return values.find(value => value.url === url);
  } }, store);
  const first = nodes.refresh(), second = nodes.refresh();
  assert.equal(first, second);
  await first;
  assert.ok(peak <= 3 && peak > 1);
  const status = nodes.status();
  assert.equal(status.refreshing, false);
  assert.equal(status.peers.length, 8);
  assert.equal(status.peers[0].status, 'offline');
  assert.equal(status.peers[1].status, 'identity-changed');
  assert.equal(status.peers[1].id, values[1].id);
  assert.equal(status.peers[2].online, true);
  await nodes.stop();
});

test('discovered hints are bounded, expire, and never trigger automatic HTTP probes or persistence', async () => {
  let now = 100000, calls = 0;
  const store = memoryStore();
  const nodes = manager({}, { now: () => now, probe: async () => { calls++; return descriptor(); } }, store);
  for (let i = 0; i < MAX_PEERS + 20; i++) nodes.discovered({ ...descriptor(), url: 'http://10.1.1.2:4000', lastSeenAt: new Date(now).toISOString() });
  assert.equal(nodes.status().nearby.length, MAX_PEERS);
  assert.equal(nodes.status().peers.length, 0);
  assert.equal(store.setting('nodePeers'), null);
  nodes.start(); await nodes.refresh();
  assert.equal(calls, 0);
  now += 90001;
  assert.equal(nodes.status().nearby.length, 0);
  await nodes.stop();
});

test('stop cancels peer checks and prevents stale results from reviving removed nodes', async () => {
  const remote = descriptor(), store = memoryStore(); store.setSetting('nodePeers', [{ ...remote, url: 'http://10.0.0.5:4000' }]);
  let aborted = false;
  const nodes = manager({}, { probe: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Error('Cancelled')); }, { once: true });
  }) }, store);
  const refreshing = nodes.refresh();
  await nodes.stop(); await refreshing;
  assert.equal(aborted, true);
  assert.equal(nodes.controllers.size, 0);
  assert.equal(nodes.status().peers[0].status, 'unchecked');
  await assert.rejects(nodes.probe('http://10.0.0.5:4000'), /stopping/);
});

test('LAN discovery uses sender IP, ignores untrusted URLs and malformed traffic, and closes its socket', () => {
  const socket = new EventEmitter(); socket.sent = []; socket.closed = false;
  socket.bind = (_port, _address, ready) => ready(); socket.setMulticastTTL = value => { socket.ttl = value; };
  socket.setMulticastLoopback = () => {}; socket.addMembership = value => { socket.group = value; };
  socket.unref = () => {}; socket.close = () => { socket.closed = true; };
  socket.send = (packet, port, group, done) => { socket.sent.push({ packet, port, group }); done(); };
  const self = descriptor(), remote = descriptor(), seen = [];
  const discovery = new LanDiscovery({ descriptor: () => self, url: () => 'http://192.168.1.10:4000', onPeer: peer => seen.push(peer), socketFactory: () => socket });
  discovery.start(); assert.equal(discovery.status().active, true);
  assert.equal(socket.ttl, 1); assert.equal(socket.group, GROUP);
  assert.equal(socket.sent[0].port, PORT);
  const packet = Buffer.from(JSON.stringify({ discovery: PROTOCOL, kind: 'hello', id: remote.id, name: remote.name, scheme: 'http', port: 4001, url: 'http://169.254.169.254' }));
  socket.emit('message', packet, { address: '192.168.1.23' });
  assert.equal(seen[0].url, 'http://192.168.1.23:4001');
  socket.emit('message', packet, { address: '169.254.169.254' });
  socket.emit('message', Buffer.alloc(1025), { address: '192.168.1.23' });
  socket.emit('message', Buffer.from('{bad'), { address: '192.168.1.23' });
  assert.equal(seen.length, 1);
  discovery.stop(); assert.equal(socket.closed, true); assert.equal(discovery.status().active, false);
});

test('late events from a replaced discovery socket cannot stop or populate its successor', () => {
  const sockets = [], seen = [], self = descriptor(), remote = descriptor();
  const discovery = new LanDiscovery({ descriptor: () => self, url: () => 'http://10.0.0.3:4000', onPeer: value => seen.push(value), socketFactory: () => {
    const socket = new EventEmitter(); socket.bind = (_port, _host, ready) => ready();
    socket.setMulticastTTL = socket.setMulticastLoopback = socket.addMembership = socket.unref = socket.close = () => {};
    socket.send = (_packet, _port, _group, done) => done(); sockets.push(socket); return socket;
  } });
  discovery.start(); discovery.stop(); discovery.start();
  sockets[0].emit('error', Error('Late close'));
  sockets[0].emit('message', Buffer.from(JSON.stringify({ discovery: PROTOCOL, kind: 'hello', id: remote.id, name: remote.name, scheme: 'http', port: 4000 })), { address: '10.0.0.5' });
  assert.equal(discovery.status().active, true); assert.equal(seen.length, 0);
  discovery.stop();
});

test('discovery errors leave manual connections usable and require a reachable advertisement address', async () => {
  const empty = new LanDiscovery({ descriptor: () => descriptor(), url: () => '', onPeer: () => {} });
  empty.start(); assert.match(empty.status().error, /Set this server/);
  const loopback = new LanDiscovery({ descriptor: () => descriptor(), url: () => 'http://127.0.0.1:4000', onPeer: () => {} });
  loopback.start(); assert.match(loopback.status().error, /LAN address/);
  const remote = descriptor(), nodes = manager({}, { probe: async () => remote });
  assert.throws(() => nodes.updateSettings({ discoveryEnabled: true }), /Set the address/);
  assert.throws(() => nodes.updateSettings({ url: 'http://localhost:4000', discoveryEnabled: true }), /LAN address/);
  await nodes.add({ url: 'http://192.168.1.30:4000' });
  assert.equal(nodes.status().peers.length, 1); await nodes.stop();
});

test('discovery surfaces blocked UDP sends and ignores stale socket callbacks after restart', () => {
  const sockets = [], self = descriptor();
  function factory() {
    const socket = new EventEmitter(); sockets.push(socket);
    socket.bind = (_port, _address, done) => done();
    socket.setMulticastTTL = socket.setMulticastLoopback = socket.unref = socket.close = () => {};
    socket.addMembership = (_group, address) => { socket.joined = address; };
    socket.setMulticastInterface = address => { socket.outbound = address; };
    socket.send = (_packet, _port, _group, done) => { socket.callback = done; done(Object.assign(Error('Blocked'), { code: 'EHOSTUNREACH' })); };
    return socket;
  }
  const discovery = new LanDiscovery({ descriptor: () => self, url: () => 'http://192.168.1.10:4000', onPeer: () => {}, socketFactory: factory,
    interfaces: () => ({ lan: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }] }) });
  discovery.start();
  assert.match(discovery.status().error, /EHOSTUNREACH/);
  assert.equal(sockets[0].joined, '192.168.1.10');
  assert.equal(sockets[0].outbound, '192.168.1.10');
  discovery.stop(); discovery.start();
  sockets[0].emit('error', Error('Old socket'));
  sockets[0].callback(null);
  assert.equal(discovery.status().active, true);
  assert.match(discovery.status().error, /EHOSTUNREACH/);
  discovery.stop();
});

function invoke(handler, { body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.headers = { host: 'localhost:4000', ...headers };
  const result = { status: null, data: null };
  const res = { writeHead(status) { result.status = status; }, end(value) { result.data = JSON.parse(value); } };
  return Promise.resolve(handler(req, res)).then(() => result);
}
test('node management is owner-only and same-origin while public identity excludes the directory', async () => {
  const cfg = { adminPassword: 'secret', sessionSecret: 'private-test-secret' };
  const nodes = manager(cfg); const handlers = nodesHandlers(cfg, nodes);
  const info = await invoke(handlers.info);
  assert.equal(info.status, 200); assert.deepEqual(info.data, nodes.descriptor());
  assert.equal((await invoke(handlers.list)).status, 403);
  assert.equal((await invoke(handlers.add, { body: { url: 'http://10.0.0.3:4000' }, headers: { 'content-type': 'application/json' } })).status, 403);
  const local = nodesHandlers({}, nodes);
  assert.equal((await invoke(local.settings, { body: { name: 'A' } })).status, 415);
  assert.equal((await invoke(local.settings, { body: { name: 'A' }, headers: { 'content-type': 'application/json', origin: 'http://other.example' } })).status, 403);
  assert.equal((await invoke(local.settings, { body: { name: 'A' }, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })).status, 415);
  cfg.setupRequired = true; assert.equal((await invoke(handlers.info)).status, 503);
  await nodes.stop();
});

test('real metadata probes pin DNS, use a fixed path, and do not follow redirects or send credentials', async t => {
  const remote = descriptor(); let mode = 'ok', hits = 0, observed;
  const server = http.createServer((req, res) => {
    hits++; observed = req;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return; }
    if (mode === 'large') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('x'.repeat(9000)); return; }
    if (mode === 'stall') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(remote));
  });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Local listeners unavailable in this execution environment'); return; } throw error; }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://safe.test:' + server.address().port;
  let lookups = 0;
  const options = { lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } };
  const result = await fetchDescriptor(origin, options);
  assert.equal(result.id, remote.id); assert.equal(lookups, 1);
  assert.equal(observed.url, '/api/node-info');
  assert.equal(observed.headers.host, new URL(origin).host);
  assert.equal(observed.headers.cookie, undefined); assert.equal(observed.headers.authorization, undefined);
  mode = 'redirect'; const before = hits;
  await assert.rejects(fetchDescriptor(origin, options), /redirects/); assert.equal(hits, before + 1);
  mode = 'large'; await assert.rejects(fetchDescriptor(origin, options), /too large/);
  mode = 'stall'; await assert.rejects(fetchDescriptor(origin, { ...options, timeoutMs: 50 }), /timed out/);
  const unsafeBefore = hits;
  await assert.rejects(fetchDescriptor(origin, { lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }] }), /metadata/);
  assert.equal(hits, unsafeBefore);
});
