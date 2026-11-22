'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isAdmin, hasSameOrigin } = require('./auth');
const { readJsonBody } = require('./body');
const { sendJson } = require('./handlers/api');
const { createCompose } = require('../scripts/setup-compose');

const actions = new Set(['inspect', 'browse', 'save', 'apply', 'stop', 'migrate']);
const heartbeat = 20_000;

function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }

function selectedFolders(folders) {
  if (!Array.isArray(folders) || folders.length < 1 || folders.length > 256 ||
      !folders.every(f => typeof f === 'string' && f.length > 0 && f.length <= 4096 && !/[\x00-\x1f\x7f]/.test(f)) ||
      new Set(folders).size !== folders.length) throw fault('Choose between 1 and 256 distinct folders.');
  return folders;
}

function deploymentOptions(value) {
  if (!value || typeof value !== 'object') throw fault('Enter the memory and network settings.');
  const deployment = {};
  for (const key of ['port', 'bind', 'host', 'memory', 'swap']) {
    if (!['number', 'string'].includes(typeof value[key]) || String(value[key]).length > 255) throw fault('Complete each deployment field.');
    deployment[key] = value[key];
  }
  return deployment;
}

function requestFor(body) {
  const action = body?.action;
  if (!actions.has(action)) throw fault('Choose a host action.');
  if (action === 'browse') {
    if (typeof body.path !== 'string' || !body.path || body.path.length > 4096) throw fault('Choose a host folder.');
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw fault('Invalid directory page.');
    return { action, path: body.path, offset };
  }
  if (action === 'save') {
    if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw fault('Reload the saved installation settings.');
    return { action, folders: selectedFolders(body.folders), deployment: deploymentOptions(body.deployment), revision: body.revision };
  }
  if (action === 'stop') {
    const resumeMinutes = body.resumeMinutes ?? 0;
    if (!Number.isInteger(resumeMinutes) || resumeMinutes < 0 || resumeMinutes > 1440) throw fault('Choose a restart delay from 0 to 1440 minutes.');
    return { action, resumeMinutes };
  }
  return { action };
}

class HostManagement {
  constructor(cfg) {
    this.dir = cfg.updateDirectory || '';
    this.pending = null;
  }

  async status() {
    let report;
    let handle;
    if (this.dir) {
      try {
        const file = path.join(this.dir, 'host-status.json');
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const info = await handle.stat();
        if (info.isFile() && info.size < 2 * 1024 * 1024) report = JSON.parse(await handle.readFile('utf8'));
      } catch {} finally { await handle?.close().catch(() => {}); }
    }
    const connected = Math.abs(Date.now() - Date.parse(report?.heartbeatAt)) <= heartbeat;
    const job = connected ? report?.job || null : null;
    if (job?.id === this.pending?.id || Date.now() - (this.pending?.at || 0) > heartbeat) this.pending = null;
    return { managed: Boolean(this.dir), connected, job: this.pending?.job || job };
  }

  async send(body) {
    const request = requestFor(body);
    if (this.sending) throw fault('Another host request is being submitted.', 409);
    this.sending = true;
    let temporary;
    try {
      const { connected, job } = await this.status();
      if (!connected) throw fault('On the host, open Start-Here and choose Start existing VidStream to connect installation controls.', 409);
      if (['queued', 'running'].includes(job?.state)) throw fault('A host action is still running. Wait for it to finish.', 409);
      const id = randomUUID();
      const packet = JSON.stringify({ ...request, id });
      if (Buffer.byteLength(packet) > 256 * 1024) throw fault('The folder list exceeds the host request limit.');
      temporary = path.join(this.dir, '.host-request-' + id);
      const handle = await fs.open(temporary, 'wx', 0o644);
      try {
        await handle.writeFile(packet);
        await handle.chmod(0o644);
      } finally { await handle.close(); }
      try { await fs.link(temporary, path.join(this.dir, 'host-request.json')); }
      catch (error) {
        if (error.code === 'EEXIST') throw fault('Another action is waiting for the host.', 409);
        throw error;
      }
      this.pending = { id, at: Date.now(), job: { id, action: request.action, state: 'queued', message: 'Waiting for the host.' } };
      return { id };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      this.sending = false;
    }
  }
}

function hostHandlers(cfg) {
  const manager = new HostManagement(cfg);
  const owner = (req, res, mutate) => {
    if (!isAdmin(req, cfg)) { sendJson(res, 403, { error: 'Owner sign-in required.' }); return false; }
    if (mutate && (!req.headers.origin || !hasSameOrigin(req, cfg) || req.headers['sec-fetch-site'] === 'cross-site')) {
      sendJson(res, 403, { error: 'Open Settings on this VidStream server to manage the host.' }); return false;
    }
    return true;
  };
  return {
    status: async (req, res) => { if (owner(req, res, false)) sendJson(res, 200, await manager.status()); },
    action: async (req, res) => {
      if (!owner(req, res, true)) return;
      try { sendJson(res, 202, await manager.send(await readJsonBody(req, 256 * 1024))); }
      catch (error) { sendJson(res, error.status || 503, { error: error.status ? error.message : 'The host could not receive the request.' }); }
    },
    compose: async (req, res) => {
      if (!owner(req, res, true)) return;
      try {
        const body = await readJsonBody(req, 256 * 1024);
        const yaml = createCompose({ image: 'vidstream-starter:local', ...deploymentOptions(body.deployment),
          role: body.role || 'server', theme: body.theme || 'light-table', folders: selectedFolders(body.folders) });
        res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="compose.yaml"', 'Cache-Control': 'no-store' });
        res.end('x-vidstream-bootstrap: true\n' + yaml);
      } catch (error) { sendJson(res, 400, { error: error.message }); }
    },
  };
}

module.exports = { hostHandlers };
