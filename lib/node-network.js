'use strict';

const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nodeError(message, status = 400) {
  const error = new Error(message); error.status = status; return error;
}
function nodeName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw nodeError('Use a library name of 1–80 characters.');
  return value.trim();
}
function normalizeNodeUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value.trim()))
    throw nodeError('Enter only the server address, such as http://192.168.1.20:4000, without a path, password, query or fragment.');
  let url;
  try { url = new URL(value.trim()); } catch { throw nodeError('Enter a valid HTTP or HTTPS server address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.pathname !== '/' || url.search || url.hash)
    throw nodeError('Enter an HTTP(S) server address without credentials or a path.');
  if (url.port && Number(url.port) < 1024 && !['80', '443'].includes(url.port))
    throw nodeError('Use port 80, 443, or an application port from 1024 to 65535.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal'].includes(hostname))
    throw nodeError('Cloud metadata addresses are not library servers.');
  return url.origin;
}
function ipv4Parts(address) {
  return net.isIP(address) === 4 ? address.split('.').map(Number) : null;
}
function isLanAddress(address) {
  const p = ipv4Parts(address);
  return Boolean(p && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)));
}
function isAllowedAddress(address) {
  const p = ipv4Parts(address);
  if (p) {
    if (p[0] === 0 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || address === '100.100.100.200') return false;
    return true; // Includes private LAN, loopback for separate local instances, and public servers.
  }
  if (net.isIP(address) !== 6) return false;
  const compact = new URL('http://[' + address + ']/').hostname.slice(1, -1).toLowerCase();
  // Mapped IPv4 must pass the same policy, rather than hiding metadata IPs.
  if (compact.startsWith('::ffff:')) {
    const tail = compact.slice(7);
    if (net.isIP(tail) === 4) return isAllowedAddress(tail);
    const parts = tail.split(':');
    if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const a = parseInt(parts[0], 16), b = parseInt(parts[1], 16);
      return isAllowedAddress([a >> 8, a & 255, b >> 8, b & 255].join('.'));
    }
    return false;
  }
  if (compact === '::1') return true;
  if (compact === 'fd00:ec2::254' || compact.startsWith('2001:db8:')) return false;
  return /^[23][0-9a-f]{3}:/.test(compact) || /^f[cd][0-9a-f]{2}:/.test(compact);
}
function validateDescriptor(value) {
  if (!value || value.product !== 'VidStream' || value.protocol !== 1 || !UUID.test(value.id || ''))
    throw nodeError('This address did not return a compatible VidStream node identity.');
  return { product: 'VidStream', protocol: 1, id: value.id.toLowerCase(), name: nodeName(value.name) };
}
function abortError() { return nodeError('The server check was cancelled or timed out.', 408); }
function untilAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function fetchDescriptor(value, { signal: outerSignal, lookup = dns.lookup, timeoutMs = 3000, maxBytes = 8192 } = {}) {
  const origin = normalizeNodeUrl(value), url = new URL(origin + '/api/node-info');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outerSignal?.aborted) throw abortError();
  outerSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs); timer.unref?.();
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = net.isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await untilAbort(lookup(hostname, { all: true, verbatim: true }), controller.signal);
    if (!addresses.length || addresses.some(entry => !isAllowedAddress(entry.address)))
      throw nodeError('This address resolves to a reserved, link-local or metadata destination.');
    const pinned = addresses.find(entry => entry.family === 4) || addresses[0];
    const descriptor = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', agent: false, autoSelectFamily: false, signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'VidStream-Node/1', Connection: 'close' },
        // Resolve once and pin the socket. A second lookup cannot rebind to a
        // different destination after the policy check. TLS validation stays on.
        lookup: (_host, options, callback) => options.all
          ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          const message = response.statusCode >= 300 && response.statusCode < 400
            ? 'Server checks do not follow redirects. Enter the final VidStream server address.'
            : response.statusCode === 503 ? 'Complete owner setup on that server first.' : 'The server did not provide its VidStream node identity.';
          reject(nodeError(message)); request.destroy(); return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
          response.resume(); reject(nodeError('The server did not return a JSON node identity.')); request.destroy(); return;
        }
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { reject(nodeError('The node identity response was too large.')); request.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(validateDescriptor(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
          catch (error) { reject(error.status ? error : nodeError('The server returned an invalid node identity.')); }
        });
      });
      request.on('error', error => reject(controller.signal.aborted ? abortError() : nodeError('Could not reach the server: ' + error.message)));
      request.end();
    });
    return { ...descriptor, url: origin, online: true };
  } finally {
    clearTimeout(timer); outerSignal?.removeEventListener('abort', abort);
  }
}

module.exports = { UUID, nodeError, nodeName, normalizeNodeUrl, isAllowedAddress, isLanAddress, validateDescriptor, fetchDescriptor };
