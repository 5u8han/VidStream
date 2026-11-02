'use strict';

const crypto = require('node:crypto');
const { LanDiscovery } = require('./node-discovery');
const { UUID, nodeError, nodeName, normalizeNodeUrl, validateDescriptor, fetchDescriptor } = require('./node-network');

const MAX_PEERS = 64;
const NEARBY_TTL_MS = 90000;

class NodeManager {
  constructor(cfg, store, { probe = fetchDescriptor, discoveryFactory = options => new LanDiscovery(options), now = Date.now, refreshIntervalMs = 60000 } = {}) {
    this.cfg = cfg; this.store = store; this.probeRemote = probe; this.now = now;
    this.refreshIntervalMs = refreshIntervalMs;
    const identity = store.setting('nodeIdentity');
    this.id = typeof identity === 'string' && UUID.test(identity) ? identity.toLowerCase() : crypto.randomUUID();
    if (identity !== this.id) store.setSetting('nodeIdentity', this.id);
    const saved = store.setting('nodeSettings', {}) || {};
    let url = '';
    const configuredUrl = Object.hasOwn(saved, 'url') ? saved.url : cfg.nodeUrl || cfg.url;
    try { if (configuredUrl) url = normalizeNodeUrl(configuredUrl); } catch { /* Configuration can be corrected in Settings. */ }
    this.settings = {
      name: typeof saved.name === 'string' ? saved.name : String(cfg.nodeName || cfg.title || 'VidStream').slice(0, 80),
      url, discoveryEnabled: typeof saved.discoveryEnabled === 'boolean' ? saved.discoveryEnabled : cfg.nodeDiscovery === true,
    };
    try { this.settings.name = nodeName(this.settings.name); } catch { this.settings.name = 'VidStream'; }
    this.peers = new Map();
    const peers = store.setting('nodePeers', []);
    if (Array.isArray(peers)) for (const value of peers.slice(0, MAX_PEERS)) {
      try {
        const peer = validateDescriptor({ ...value, product: 'VidStream', protocol: 1 });
        const origin = normalizeNodeUrl(value.url);
        if (peer.id !== this.id && !this.peers.has(peer.id)) this.peers.set(peer.id, {
          id: peer.id, name: peer.name, url: origin, online: null, status: 'unchecked', lastCheckedAt: null,
        });
      } catch { /* Invalid saved entries never become outbound requests. */ }
    }
    this.nearby = new Map(); this.controllers = new Set();
    this.started = false; this.stopped = false; this.refreshing = false; this.refreshPromise = null; this.timer = null;
    this.discovery = discoveryFactory({ descriptor: () => this.descriptor(), url: () => this.settings.url,
      onPeer: peer => this.discovered(peer), now });
  }
  descriptor() { return { product: 'VidStream', protocol: 1, id: this.id, name: this.settings.name }; }
  status() {
    const cutoff = this.now() - NEARBY_TTL_MS;
    for (const [key, peer] of this.nearby) if (Date.parse(peer.lastSeenAt) < cutoff) this.nearby.delete(key);
    return {
      self: { id: this.id, ...this.settings },
      peers: [...this.peers.values()].map(peer => ({ ...peer })),
      nearby: [...this.nearby.values()].filter(peer => !this.peers.has(peer.id)).map(peer => ({ ...peer })),
      discovery: { enabled: this.settings.discoveryEnabled, ...this.discovery.status() },
      refreshing: this.refreshing,
      limits: { maxPeers: MAX_PEERS },
    };
  }
  discovered(peer) {
    if (peer.id === this.id) return;
    if (peer.departed) { this.nearby.delete(peer.id); return; }
    if (!this.nearby.has(peer.id) && this.nearby.size >= MAX_PEERS) return;
    this.nearby.set(peer.id, { id: peer.id, name: peer.name, url: peer.url, lastSeenAt: peer.lastSeenAt });
  }
  start() {
    if (this.started) return;
    this.started = true; this.stopped = false;
    this.restartDiscovery();
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.refreshIntervalMs);
    this.timer.unref?.();
  }
  restartDiscovery() {
    this.discovery.stop();
    if (this.started && this.settings.discoveryEnabled && !this.cfg.setupRequired) this.discovery.start();
  }
  updateSettings(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw nodeError('Invalid node settings.');
    const next = { ...this.settings };
    if (body.name !== undefined) next.name = nodeName(body.name);
    if (body.url !== undefined) next.url = body.url === '' ? '' : normalizeNodeUrl(body.url);
    if (body.discoveryEnabled !== undefined) {
      if (typeof body.discoveryEnabled !== 'boolean') throw nodeError('LAN discovery must be enabled or disabled.');
      next.discoveryEnabled = body.discoveryEnabled;
    }
    if (next.discoveryEnabled && !next.url) throw nodeError('Set the address other devices use to open this server before enabling discovery.');
    if (next.discoveryEnabled) {
      const hostname = new URL(next.url).hostname;
      if (hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]')
        throw nodeError('Discovery needs a LAN address other devices can open, not localhost.');
    }
    this.store.setSetting('nodeSettings', next); this.settings = next;
    this.restartDiscovery();
    return this.status();
  }
  async probe(value) {
    if (this.stopped) throw nodeError('The node service is stopping.', 503);
    if (this.controllers.size >= 16) throw nodeError('Several server checks are already running. Try again shortly.', 429);
    const origin = normalizeNodeUrl(value);
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const result = await this.probeRemote(origin, { signal: controller.signal });
      if (this.stopped || controller.signal.aborted) throw nodeError('The server check was cancelled.', 408);
      const descriptor = validateDescriptor(result);
      if (descriptor.id === this.id) throw nodeError('That server has this library’s identity. Use separate data directories for separate nodes; cloned application data is not a new node.', 409);
      return { id: descriptor.id, name: descriptor.name, url: origin, online: true };
    } finally { this.controllers.delete(controller); }
  }
  savePeers() {
    this.store.setSetting('nodePeers', [...this.peers.values()].map(({ id, name, url }) => ({ id, name, url })));
  }
  async add(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw nodeError('Check a server address before adding it.');
    if (body.expectedId !== undefined && !UUID.test(body.expectedId || '')) throw nodeError('The checked node identity is invalid.');
    const peer = await this.probe(body.url);
    if (body.expectedId && peer.id !== body.expectedId.toLowerCase()) throw nodeError('The server identity changed since it was checked. Check the address again before adding it.', 409);
    const existing = this.peers.get(peer.id);
    if (existing && existing.url !== peer.url) throw nodeError('This node is already saved at another address. Remove that entry before replacing its address.', 409);
    if ([...this.peers.values()].some(value => value.url === peer.url && value.id !== peer.id))
      throw nodeError('This address belongs to a different saved identity. Remove the old entry before adding its replacement.', 409);
    if (!existing && this.peers.size >= MAX_PEERS) throw nodeError('The switcher supports up to 64 saved nodes. Remove one before adding another.');
    this.peers.set(peer.id, { ...peer, status: 'online', lastCheckedAt: new Date(this.now()).toISOString() });
    this.savePeers(); this.nearby.delete(peer.id);
    return this.status();
  }
  remove(id) {
    if (!UUID.test(id || '')) throw nodeError('Choose a saved node to remove.');
    this.peers.delete(id.toLowerCase()); this.savePeers();
    return this.status();
  }
  refresh() {
    if (this.stopped) return Promise.resolve(this.status());
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshing = true;
    const pending = [...this.peers.values()];
    const worker = async () => {
      while (pending.length && !this.stopped) {
        const peer = pending.shift();
        let result;
        try {
          const fresh = await this.probe(peer.url);
          result = fresh.id === peer.id
            ? { online: true, status: 'online', name: fresh.name }
            : { online: false, status: 'identity-changed', error: 'The saved node identity no longer matches this address. Check it before reconnecting.' };
        } catch (error) { result = { online: false, status: error.status === 409 ? 'identity-changed' : 'offline', error: String(error.message).slice(0, 240) }; }
        // A removed/replaced node or shutdown cannot be revived by a stale check.
        if (!this.stopped && this.peers.get(peer.id) === peer) {
          Object.assign(peer, result, { lastCheckedAt: new Date(this.now()).toISOString() });
          if (!result.error) delete peer.error;
        }
      }
    };
    this.refreshPromise = Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker))
      .then(() => { this.refreshing = false; return this.status(); }).finally(() => { this.refreshing = false; this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async stop() {
    this.stopped = true; this.started = false;
    clearInterval(this.timer); this.timer = null;
    this.discovery.stop();
    for (const controller of this.controllers) controller.abort();
    if (this.refreshPromise) await this.refreshPromise;
  }
}

module.exports = { NodeManager, MAX_PEERS, NEARBY_TTL_MS };
