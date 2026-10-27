'use strict';
const { checkCredentials, setSessionCookie, clearSessionCookie, authConfigured } = require('../auth');
const { readJsonBody } = require('../body');
const { sendJson } = require('./api');
const limiter = require('../ratelimit');

function loginHandler(cfg) {
  return async (req, res) => {
    const key = limiter.clientKey(req, cfg);
    if (limiter.isBlocked(key)) {
      return sendJson(res, 429, { ok: false, error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const body = await readJsonBody(req);
    if (!authConfigured(cfg)) {
      setSessionCookie(res, cfg, req);
      return sendJson(res, 200, { ok: true });
    }
    if (await checkCredentials(body.username, body.password, cfg)) {
      limiter.recordSuccess(key);
      setSessionCookie(res, cfg, req);
      return sendJson(res, 200, { ok: true });
    }
    limiter.recordFailure(key);
    sendJson(res, 401, { ok: false, error: 'Incorrect username or password' });
  };
}

function logoutHandler() {
  return async (req, res) => {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
  };
}

module.exports = { loginHandler, logoutHandler };
