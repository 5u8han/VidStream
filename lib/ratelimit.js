'use strict';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;
const fails = new Map();

function clientKey(req, cfg) {
  if (cfg.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function prune(list, now) {
  while (list.length && now - list[0] > WINDOW_MS) list.shift();
}

function isBlocked(key) {
  const list = fails.get(key);
  if (!list) return false;
  prune(list, Date.now());
  if (!list.length) { fails.delete(key); return false; }
  return list.length >= MAX_FAILS;
}

function recordFailure(key) {
  const now = Date.now();
  const list = fails.get(key) || [];
  list.push(now);
  fails.set(key, list);
  if (fails.size > 5000) {
    for (const [k, v] of fails) { prune(v, now); if (!v.length) fails.delete(k); }
  }
}

function recordSuccess(key) { fails.delete(key); }

module.exports = { clientKey, isBlocked, recordFailure, recordSuccess };
