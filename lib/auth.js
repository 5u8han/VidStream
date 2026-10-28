'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exec');

const COOKIE_NAME = 'stream_session';
const SESSION_DAYS = 30;
// Deliberately restrictive -- this is substituted directly into an LDAP
// bind DN, so anything that could break DN syntax (comma, equals, plus,
// quotes, etc.) is rejected outright rather than escaped, which is
// simpler to reason about as actually safe.
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{1,64}$/;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function makeToken(secret, role) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${expires}.${role}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expires, role, sig] = parts;
  const payload = `${expires}.${role}`;
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
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// The server initializes first-time owner setup before accepting requests.
// Bare configuration objects retain legacy behavior for embedded callers.
function authConfigured(cfg) {
  return Boolean(cfg.localPassword || cfg.adminPassword || (cfg.ldapUrl && cfg.ldapBindDnTemplate));
}

function getRole(req, cfg) {
  if (!authConfigured(cfg)) return cfg.setupRequired ? 'anonymous' : 'admin';
  const cookies = parseCookies(req.headers.cookie);
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

// Tests the given credentials as an LDAP bind via the standard
// `ldapwhoami` client tool (part of most distros' ldap-utils package)
// rather than implementing the LDAP wire protocol by hand -- a
// successful bind+whoami (exit 0) means the credentials are valid. The
// password is written to a 0600 temp file and passed via -y rather than
// as a CLI argument, since arguments are visible to other processes on
// the same host via `ps`.
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
    return false; // wrong credentials, unreachable server, or ldap-utils not installed
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Tries the static admin account first (fast, and still works even if
// an LDAP server is down or misconfigured), then LDAP if configured.
// A blank ADMIN_USERNAME means "any username" for the static check --
// set it to require a specific username too.
async function checkCredentials(username, password, cfg) {
  if (username===cfg.localUsername && await require('./security').verifyPassword(password,cfg.localPassword)) return true;
  const usernameOk = !cfg.adminUsername || username === cfg.adminUsername;
  if (usernameOk && checkStaticPassword(password, cfg)) return true;
  return checkLdap(username, password, cfg);
}

function setSessionCookie(res, cfg, req) {
  const token = makeToken(cfg.sessionSecret, 'admin');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  // Behind Cloudflare/a TLS-terminating proxy the app itself sees plain
  // HTTP, but the proxy says what the browser used.
  const secure = req && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

module.exports = {
  getRole,
  isAdmin,
  authConfigured,
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME,
};
