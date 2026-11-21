'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isAdmin, hasSameOrigin } = require('./auth');
const { sendJson } = require('./handlers/api');
const { version } = require('../package.json');

const run = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set(['idle', 'checking', 'updating', 'current', 'available', 'failed', 'completed']);
const ACTIVE = new Set(['checking', 'updating']);
const HEARTBEAT_MS = 20_000;
const GITHUB_MAIN = 'https://api.github.com/repos/5u8han/VidStream/commits/main';

function revision(value) {
  return typeof value === 'string' && SHA.test(value) ? value : null;
}

class AppUpdate {
  constructor(cfg, { fetchRemote = fetch, now = Date.now } = {}) {
    this.cfg = cfg;
    this.fetchRemote = fetchRemote;
    this.now = now;
    this.directory = cfg.updateDirectory || '';
    this.local = { state: 'idle', message: 'Check for a newer build on GitHub.' };
    this.runningRevision = this.installedRevision();
  }

  async installedRevision() {
    const configured = revision(this.cfg.appRevision);
    if (configured) return configured;
    if (this.cfg.dockerRuntime) return null;
    try {
      await fs.lstat(path.join(this.cfg.rootDir, '.git'));
      const options = { timeout: 3000, maxBuffer: 4096 };
      const changed = await run('git', ['-C', this.cfg.rootDir, 'status', '--porcelain', '--untracked-files=no'], options);
      if (changed.stdout.trim()) return null;
      const result = await run('git', ['-C', this.cfg.rootDir, 'rev-parse', '--verify', 'HEAD'], {
        timeout: 3000, maxBuffer: 128,
      });
      return revision(result.stdout.trim());
    } catch { return null; }
  }

  async status() {
    let remote;
    if (this.directory) {
      let handle;
      try {
        if (!(await fs.lstat(this.directory)).isDirectory()) throw Error('Invalid update directory');
        const file = path.join(this.directory, 'status.json');
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 16 * 1024) throw Error('Invalid update status');
        remote = JSON.parse(await handle.readFile('utf8'));
      } catch {}
      finally { await handle?.close().catch(() => {}); }
    }
    const timestamp = Date.parse(remote?.heartbeatAt);
    const connected = Number.isFinite(timestamp) && Math.abs(this.now() - timestamp) <= HEARTBEAT_MS && STATES.has(remote.state);
    if (this.requested && remote?.id === this.requested.id) this.requested = null;
    const pending = connected && this.requested && this.now() - this.requested.at < HEARTBEAT_MS ? this.requested : null;
    const source = pending ? { ...remote, id: pending.id, state: pending.action === 'check' ? 'checking' : 'updating',
      message: pending.action === 'check' ? 'Checking GitHub for updates…' : 'Preparing the update on the host…' } : connected ? remote : this.local;
    const reportedRevision = connected ? revision(remote.currentRevision) : null;
    const currentRevision = await this.runningRevision || reportedRevision;
    const targetRevision = revision(source.targetRevision);
    const staleReport = ['current', 'available', 'completed'].includes(source.state) &&
      reportedRevision && reportedRevision !== currentRevision;
    const unverified = staleReport || (['current', 'completed'].includes(source.state) &&
      (!currentRevision || currentRevision !== targetRevision));
    const state = unverified ? 'unknown' : source.state;
    return {
      version,
      state,
      currentRevision,
      targetRevision,
      connected,
      managed: Boolean(this.directory),
      canUpdate: connected && state === 'available' && Boolean(targetRevision) && currentRevision !== targetRevision,
      message: unverified ? 'Check again to compare the current running build with GitHub.' : String(source.message || '').slice(0, 600),
      checkedAt: source.checkedAt || null,
      requestId: typeof source.id === 'string' ? source.id.slice(0, 64) : null,
    };
  }

  async send(action) {
    if (action !== 'check' && action !== 'update') throw Object.assign(Error('Unknown update action.'), { status: 400 });
    if (this.sending) throw Object.assign(Error('An update request is already being saved.'), { status: 409 });
    this.sending = true;
    let temporary;
    try {
      const state = await this.status();
      if (!state.connected) {
        if (action === 'check') return this.checkGitHub();
        throw Object.assign(Error('Open Start-Here on this host and choose Start existing VidStream to connect the update helper.'), { status: 409 });
      }
      if (ACTIVE.has(state.state)) throw Object.assign(Error('An update operation is already running.'), { status: 409 });
      if (action === 'update' && ['current', 'completed'].includes(state.state) &&
          state.currentRevision && state.currentRevision === state.targetRevision) return state;
      if (action === 'update' && !state.canUpdate)
        throw Object.assign(Error('Check for updates before installing a new build.'), { status: 409 });
      const id = randomUUID();
      temporary = path.join(this.directory, '.request-' + id + '.tmp');
      const handle = await fs.open(temporary, 'wx', 0o644);
      try {
        await handle.writeFile(JSON.stringify({ id, action }));
        await handle.chmod(0o644);
      } finally { await handle.close(); }
      try { await fs.link(temporary, path.join(this.directory, 'request.json')); }
      catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(Error('An update request is already waiting for the host.'), { status: 409 });
        throw error;
      }
      this.requested = { id, action, at: this.now() };
      return { ...state, requestId: id, state: action === 'check' ? 'checking' : 'updating', canUpdate: false,
        message: action === 'check' ? 'Checking GitHub for updates…' : 'The host is preparing the new build. Playback can briefly stop when it restarts.' };
    } catch (error) {
      if (error.code) throw Object.assign(Error('Could not contact the host update helper. Open Start-Here on the host and try again.'), { status: 503 });
      throw error;
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      this.sending = false;
    }
  }

  async checkGitHub() {
    if (this.checking) return this.checking;
    this.checking = this.readGitHub().finally(() => { this.checking = null; });
    return this.checking;
  }

  async readGitHub() {
    this.local = { state: 'checking', message: 'Checking GitHub for updates…' };
    try {
      const response = await this.fetchRemote(GITHUB_MAIN, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VidStream/' + version },
        redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw Error(response.status === 403 || response.status === 429
        ? 'GitHub is limiting update checks. Try again later.' : 'Could not check GitHub for updates.');
      const value = await response.json();
      if (!revision(value?.sha)) throw Error('GitHub returned an invalid build revision.');
      const current = await this.runningRevision;
      this.local = { state: current ? (current === value.sha ? 'current' : 'available') : 'unknown', targetRevision: value.sha,
        checkedAt: new Date(this.now()).toISOString(),
        message: current === value.sha ? 'You are running the latest build.' : current
          ? 'GitHub has a different build.' : 'GitHub was checked. This installation did not record its running revision.' };
    } catch (error) {
      this.local = { state: 'failed', message: error.name === 'TimeoutError' ? 'The GitHub update check timed out. Try again.' : error.message };
    }
    return this.status();
  }
}

function updateHandlers(cfg, service = new AppUpdate(cfg)) {
  function owner(req, res) {
    if (isAdmin(req, cfg)) return true;
    sendJson(res, 403, { error: 'Owner sign-in is required to manage updates.' });
    return false;
  }
  function action(kind) {
    return async (req, res) => {
      if (!owner(req, res)) return;
      if (!req.headers.origin || !hasSameOrigin(req, cfg) || req.headers['sec-fetch-site'] === 'cross-site')
        return sendJson(res, 403, { error: 'Open Settings on this VidStream server to manage updates.' });
      try { sendJson(res, 200, await service.send(kind)); }
      catch (error) { sendJson(res, error.status || 503, { error: error.message }); }
    };
  }
  return {
    status: async (req, res) => { if (owner(req, res)) sendJson(res, 200, await service.status()); },
    check: action('check'), apply: action('update'),
  };
}

module.exports = { AppUpdate, updateHandlers };
