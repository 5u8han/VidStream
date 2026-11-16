'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exec');

const COOKIE_NAME = 'stream_session';
const SESSION_DAYS = 30;
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{1,64}$/;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function makeToken(secret, role, scope) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${expires}.${role}${scope ? '.' + scope : ''}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret, scope) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== (scope ? 4 : 3)) return null;
  const [expires, role] = parts;
  if (scope && parts[2] !== scope) return null;
  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join('.');
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) <= Date.now()) return null;
  return role;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    try { out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch (_) { }
  }
  return out;
}

function authConfigured(cfg) {
  return Boolean(cfg.localPassword || cfg.adminPassword || (cfg.ldapUrl && cfg.ldapBindDnTemplate));
}

function getRole(req, cfg) {
  if (!authConfigured(cfg)) return 'anonymous';
  const cookies = parseCookies(req.headers.cookie);
  if (cfg.sessionCookieName && Object.hasOwn(cookies, cfg.sessionCookieName)) {
    return verifyToken(cookies[cfg.sessionCookieName], cfg.sessionSecret, cfg.sessionCookieName) === 'admin' ? 'admin' : 'anonymous';
  }
  return verifyToken(cookies[COOKIE_NAME], cfg.sessionSecret) === 'admin' ? 'admin' : 'anonymous';
}

function isAdmin(req, cfg) {
  return getRole(req, cfg) === 'admin';
}

function checkStaticPassword(candidate, cfg) {
  if (!cfg.adminPassword) return false;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(cfg.adminPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function checkLdap(username, password, cfg) {
  if (!cfg.ldapUrl || !cfg.ldapBindDnTemplate) return false;
  if (!username || !password) return false;
  if (!USERNAME_PATTERN.test(username)) return false;

  const bindDn = cfg.ldapBindDnTemplate.replace(/\{username\}/g, username);
  const tmpFile = path.join(os.tmpdir(), `stream-ldap-${crypto.randomBytes(12).toString('hex')}`);
  try {
    fs.writeFileSync(tmpFile, password, { mode: 0o600 });
    await run('ldapwhoami', ['-x', '-H', cfg.ldapUrl, '-D', bindDn, '-y', tmpFile], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function checkCredentials(username, password, cfg) {
  const passwordOnly = !cfg.ldapUrl || !cfg.ldapBindDnTemplate;
  if ((passwordOnly || username === cfg.localUsername) &&
      await require('./security').verifyPassword(password, cfg.localPassword)) return true;
  if ((passwordOnly || !cfg.adminUsername || username === cfg.adminUsername) &&
      checkStaticPassword(password, cfg)) return true;
  return checkLdap(username, password, cfg);
}

function isSecureRequest(req, cfg) {
  return Boolean(req && (req.socket?.encrypted ||
    (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https')));
}

function hasSameOrigin(req, cfg) {
  const origin = req.headers.origin;
  return !origin || origin === (isSecureRequest(req, cfg) ? 'https://' : 'http://') + req.headers.host;
}

function setSessionCookie(res, cfg, req) {
  const name = cfg.sessionCookieName || COOKIE_NAME;
  const token = makeToken(cfg.sessionSecret, 'admin', cfg.sessionCookieName);
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const secure = isSecureRequest(req, cfg) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${name}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res, cfg = {}) {
  const names = cfg.sessionCookieName ? [cfg.sessionCookieName, COOKIE_NAME] : [COOKIE_NAME];
  const values = names.map(name => `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.setHeader('Set-Cookie', values.length === 1 ? values[0] : values);
}

module.exports = {
  getRole,
  isAdmin,
  authConfigured,
  hasSameOrigin,
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME,
};
