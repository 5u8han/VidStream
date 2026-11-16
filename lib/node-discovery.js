'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const { UUID, nodeName, normalizeNodeUrl, isLanAddress } = require('./node-network');

const GROUP = '239.255.86.83';
const PORT = 45873;
const PROTOCOL = 'VidStreamLANv1';
const MAX_PACKET = 1024;

class LanDiscovery {
  constructor({ descriptor, url, onPeer, socketFactory = options => dgram.createSocket(options), interfaces = os.networkInterfaces, now = Date.now } = {}) {
    this.descriptor = descriptor; this.url = url; this.onPeer = onPeer;
    this.socketFactory = socketFactory; this.now = now;
    this.interfaces = interfaces;
    this.socket = null; this.timer = null; this.active = false; this.error = null;
    this.outboundInterfaces = [];
    this.lastReply = 0; this.windowAt = 0; this.packets = 0;
  }
  start() {
    if (this.socket) return;
    this.error = null;
    let address;
    try { address = new URL(normalizeNodeUrl(this.url())); }
    catch { this.error = 'Set this server’s address before enabling LAN discovery.'; return; }
    const host = address.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.startsWith('127.') || host === '::1') {
      this.error = 'Use this machine’s LAN address, not localhost, for discovery.'; return;
    }
    try {
      const socket = this.socketFactory({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.on('error', () => {
        if (this.socket !== socket) return;
        this.error = 'LAN discovery is unavailable on this network. Manual server addresses still work.';
        this.stop();
      });
      socket.on('message', (packet, sender) => { if (this.socket === socket) this.receive(packet, sender); });
      socket.bind(PORT, '0.0.0.0', () => {
        if (this.socket !== socket) return;
        try {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
          const interfaces = Object.values(this.interfaces()).flat().filter(entry =>
            entry.family === 'IPv4' && !entry.internal && isLanAddress(entry.address));
          const addresses = [...new Set(interfaces.map(entry => entry.address))].slice(0, 16);
          const joined = [];
          for (const localAddress of addresses) {
            try { socket.addMembership(GROUP, localAddress); joined.push(localAddress); } catch { }
          }
          if (!joined.length) socket.addMembership(GROUP);
          this.outboundInterfaces = joined.includes(host) ? [host] : joined;
          socket.unref?.(); this.active = true;
          this.send('query'); this.send('hello');
          this.timer = setInterval(() => this.send('hello'), 30000);
          this.timer.unref?.();
        } catch {
          this.error = 'Multicast discovery could not join this network. Add server addresses manually.';
          this.stop();
        }
      });
    } catch {
      this.error = 'LAN discovery could not start. Add server addresses manually.';
      this.stop();
    }
  }
  packet(kind) {
    const self = this.descriptor(), url = new URL(normalizeNodeUrl(this.url()));
    return Buffer.from(JSON.stringify({ discovery: PROTOCOL, kind, id: self.id, name: self.name,
      scheme: url.protocol.slice(0, -1), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }));
  }
  send(kind) {
    if (!this.active || !this.socket) return;
    try {
      const packet = this.packet(kind);
      const socket = this.socket;
      if (packet.length > MAX_PACKET) return;
      const targets = socket.setMulticastInterface && this.outboundInterfaces.length ? this.outboundInterfaces : [null];
      let remaining = targets.length, successful = false, firstError = null;
      const report = error => {
        if (this.socket !== socket) return;
        successful ||= !error;
        firstError ||= error;
        if (--remaining > 0) return;
        this.error = successful ? null : 'Discovery could not send (' +
          String(firstError?.code || 'network error').slice(0, 30) + '). Check local-network permission and multicast support; manual addresses still work.';
      };
      for (const localAddress of targets) {
        try {
          if (localAddress) socket.setMulticastInterface(localAddress);
          socket.send(packet, PORT, GROUP, report);
        } catch (error) { report(error); }
      }
    } catch { }
  }
  receive(packet, sender) {
    if (!this.active || !Buffer.isBuffer(packet) || packet.length > MAX_PACKET || !isLanAddress(sender.address)) return;
    const now = this.now();
    if (now - this.windowAt > 1000) { this.windowAt = now; this.packets = 0; }
    if (++this.packets > 20) return;
    try {
      const message = JSON.parse(packet.toString('utf8'));
      if (message.discovery !== PROTOCOL || !['hello', 'query', 'bye'].includes(message.kind) ||
        !UUID.test(message.id || '') || message.id.toLowerCase() === this.descriptor().id ||
        !['http', 'https'].includes(message.scheme) || !Number.isSafeInteger(message.port) ||
        message.port < 1 || message.port > 65535) return;
      const name = nodeName(message.name);
      const url = normalizeNodeUrl(message.scheme + '://' + sender.address + ':' + message.port);
      this.onPeer({ id: message.id.toLowerCase(), name, url, lastSeenAt: new Date(now).toISOString(), departed: message.kind === 'bye' });
      if (message.kind === 'query' && now - this.lastReply > 2000) {
        this.lastReply = now; this.send('hello');
      }
    } catch { }
  }
  status() { return { active: this.active, error: this.error, port: PORT }; }
  stop() {
    clearInterval(this.timer); this.timer = null;
    const socket = this.socket;
    this.socket = null; this.active = false; this.outboundInterfaces = [];
    if (socket) {
      try { socket.close(); } catch { }
    }
  }
}

module.exports = { LanDiscovery, GROUP, PORT, PROTOCOL, MAX_PACKET };
