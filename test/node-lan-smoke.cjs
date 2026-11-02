'use strict';

// Optional real-network check: npm run test:node-lan sends a handful of
// temporary discovery announcements on the local IPv4 network. It does not
// open media, change app settings, or start a catalog/server. Both sockets
// close at completion. It is separate from CI because LAN multicast varies.
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { LanDiscovery } = require('../lib/node-discovery');
const { isLanAddress } = require('../lib/node-network');

async function main() {
  const address = Object.values(os.networkInterfaces()).flat().find(entry => entry.family === 'IPv4' && !entry.internal && isLanAddress(entry.address))?.address;
  if (!address) throw Error('No private IPv4 interface is available. Use manual library addresses; run this check on a LAN-connected machine.');
  const ids = [crypto.randomUUID(), crypto.randomUUID()], seen = [new Set(), new Set()];
  const peers = ids.map((id, index) => new LanDiscovery({
    descriptor: () => ({ id, name: 'VidStream discovery test ' + (index + 1) }),
    url: () => 'http://' + address + ':' + (45001 + index),
    onPeer: peer => { if (peer.id === ids[1 - index]) seen[index].add(peer.id); },
  }));
  try {
    peers.forEach(peer => peer.start());
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (seen.every(set => set.size === 1)) {
        console.log('LAN multicast passed: two temporary discovery instances received each other. No media or application data was used.');
        return;
      }
      await delay(100);
    }
    throw Error('Both temporary instances did not discover each other. ' + peers.map(peer => peer.status().error || (peer.status().active ? 'Socket active; multicast not received' : 'Socket inactive')).join(' · ') + '. Manual connections remain available.');
  } finally { peers.forEach(peer => peer.stop()); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
