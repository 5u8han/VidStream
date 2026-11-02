#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
function defaultDataDir() {
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'VidStream', 'native');
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'VidStream',
      'native'
    );
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'VidStream',
    'native'
  );
}
function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}
function dependencies() {
  return [
    ['ffmpeg', '-version'],
    ['convert', '-version'],
    ['exiftool', '-ver'],
    ['python3', '--version']
  ].map(([name, argument]) => {
    const result = spawnSync(name, [argument], { encoding: 'utf8', timeout: 3000 });
    return {
      name,
      available: !result.error && result.status === 0,
      detail:
        !result.error && result.status === 0
          ? String(result.stdout || result.stderr)
              .split('\n')[0]
              .slice(0, 180)
          : 'Not available on PATH'
    };
  });
}
function cleanLog(value) {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(
      /\b(ADMIN_PASSWORD|SITE_PASSWORD|SESSION_SECRET|password|passphrase|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .slice(0, 2000);
}
function validateConfig(value, fallback) {
  const result = {};
  for (const key of ['mediaDir', 'dataDir', 'cacheDir']) {
    const raw = value[key] === undefined ? fallback[key] : value[key];
    if (typeof raw !== 'string' || !raw || raw.length > 1024 || !path.isAbsolute(raw))
      throw Error(key + ' must be an absolute folder path');
    result[key] = path.resolve(raw);
  }
  const archive =
    value.originalsDir ??
    fallback.originalsDir ??
    path.join(result.dataDir, 'originals', 'original');
  if (typeof archive !== 'string' || !path.isAbsolute(archive) || archive.length > 1024)
    throw Error('Original archive must be an absolute folder path');
  result.originalsDir = path.resolve(archive);
  for (const key of ['dataDir', 'cacheDir', 'originalsDir']) {
    if (
      result[key] === result.mediaDir ||
      result[key].startsWith(result.mediaDir + path.sep) ||
      result.mediaDir.startsWith(result[key] + path.sep)
    )
      throw Error('Media must be separate from application data and cache');
  }
  result.port = Number(value.port ?? fallback.port);
  if (!Number.isSafeInteger(result.port) || result.port < 1024 || result.port > 65535)
    throw Error('Choose a server port from 1024 to 65535');
  if (value.allowLan !== undefined && typeof value.allowLan !== 'boolean')
    throw Error('Local-network access must be enabled or disabled');
  result.allowLan = value.allowLan === undefined ? fallback.allowLan : value.allowLan;
  return result;
}
async function portAvailable(port) {
  const reservation = http.createServer();
  reservation.listen(port, '127.0.0.1');
  try {
    await once(reservation, 'listening');
  } catch (error) {
    if (error.code === 'EADDRINUSE')
      throw Error(
        'Server port is already in use. Stop the Docker/native instance first, or choose a separate port and separate data folders.'
      );
    throw error;
  }
  await new Promise((resolve) => reservation.close(resolve));
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class NativeLauncher {
  constructor({
    dataDir = defaultDataDir(),
    root = ROOT,
    spawnChild = spawn,
    probe = dependencies
  } = {}) {
    this.root = root;
    this.settingsPath = path.join(dataDir, 'launcher.json');
    this.config = {
      mediaDir: path.join(os.homedir(), 'Pictures'),
      dataDir,
      cacheDir: path.join(dataDir, 'cache'),
      originalsDir: path.join(dataDir, 'originals', 'original'),
      port: 4000,
      allowLan: false
    };
    this.spawnChild = spawnChild;
    this.probe = probe;
    this.child = null;
    this.logs = [];
    this.state = 'stopped';
    this.lastError = null;
    this.lock = null;
  }
  log(value) {
    for (const line of cleanLog(value).split(/\r?\n/).filter(Boolean))
      this.logs.push({ at: new Date().toISOString(), text: line });
    this.logs = this.logs.slice(-160);
  }
  async load() {
    try {
      this.config = validateConfig(
        JSON.parse(await fs.readFile(this.settingsPath, 'utf8')),
        this.config
      );
    } catch (error) {
      if (error.code !== 'ENOENT')
        this.lastError = 'Saved launcher settings need attention: ' + error.message;
    }
    this.tools = this.probe();
    return this;
  }
  status() {
    return {
      state: this.state,
      error: this.lastError,
      config: this.config,
      logs: this.logs,
      url: 'http://127.0.0.1:' + this.config.port,
      dependencies: this.tools || [],
      hardware: {
        platform: process.platform,
        architecture: process.arch,
        node: process.versions.node,
        nodeSupported: nodeSupported(),
        cpu: os.cpus()[0]?.model || 'Unknown',
        threads: os.availableParallelism?.() || os.cpus().length,
        ramGiB: Math.round((os.totalmem() / 1073741824) * 10) / 10
      },
      note: 'Stop the Docker instance before using this native server. Docker named volumes are not automatically migrated. Choose existing data/cache folders deliberately, or use a separate library.'
    };
  }
  async acquireLock() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    this.lock = path.join(this.config.dataDir, 'native-server.lock');
    try {
      const old = JSON.parse(await fs.readFile(this.lock, 'utf8'));
      if (alive(old.childPid || old.ownerPid))
        throw Error('This data directory is already in use by a native server');
      await fs.unlink(this.lock);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.writeFile(this.lock, JSON.stringify({ ownerPid: process.pid }), {
      flag: 'wx',
      mode: 0o600
    });
  }
  async start(value = this.config) {
    if (this.child || this.state === 'starting') throw Error('The native server is already active');
    if (!nodeSupported()) throw Error('Node.js 22.13 or newer is required');
    const missing = (this.tools || this.probe()).filter((tool) => !tool.available);
    if (missing.length)
      throw Error(
        'Install these tools before starting: ' + missing.map((tool) => tool.name).join(', ')
      );
    const config = validateConfig(value, this.config);
    if (!(await fs.stat(config.mediaDir)).isDirectory())
      throw Error('The media path is not a folder');
    await portAvailable(config.port);
    this.config = config;
    await this.acquireLock();
    try {
      await fs.mkdir(config.cacheDir, { recursive: true });
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      await fs.writeFile(this.settingsPath + '.tmp', JSON.stringify(config, null, 2), {
        mode: 0o600
      });
      await fs.rename(this.settingsPath + '.tmp', this.settingsPath);
      this.state = 'starting';
      this.lastError = null;
      const child = this.spawnChild(process.execPath, ['server.js'], {
        cwd: this.root,
        env: {
          ...process.env,
          MEDIA_DIR: config.mediaDir,
          DATA_DIR: config.dataDir,
          CACHE_DIR: config.cacheDir,
          ORIGINALS_DIR: config.originalsDir,
          HOST: config.allowLan ? '0.0.0.0' : '127.0.0.1',
          PORT: String(config.port)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child = child;
      child.stdout?.on('data', (data) => {
        this.log(data);
        if (this.child === child && this.state === 'starting' && String(data).includes('listening on')) this.state = 'running';
      });
      child.stderr?.on('data', (data) => this.log(data));
      child.once('error', (error) => {
        this.lastError = error.message;
        this.log(error.message);
      });
      child.once('close', (code, signal) => {
        this.child = null;
        this.state = 'stopped';
        if (code && signal !== 'SIGTERM') this.lastError = 'Server exited with code ' + code;
        const lock = this.lock;
        this.lock = null;
        if (lock) void fs.unlink(lock).catch(() => {});
      });
      if (child.pid && this.lock)
        await fs.writeFile(
          this.lock,
          JSON.stringify({ ownerPid: process.pid, childPid: child.pid }),
          { mode: 0o600 }
        );
      return this.status();
    } catch (error) {
      if (!this.child && this.lock) {
        await fs.unlink(this.lock).catch(() => {});
        this.lock = null;
      }
      this.state = this.child ? 'starting' : 'stopped';
      throw error;
    }
  }
  async stop() {
    if (!this.child) return this.status();
    const child = this.child;
    this.state = 'stopping';
    const exited = once(child, 'close');
    child.kill('SIGTERM');
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(Error('The server is still shutting down; wait and check the logs')),
            30000
          );
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    return this.status();
  }
  async listen(port = 0) {
    await this.load();
    this.server = http.createServer(async (req, res) => {
      const origin = 'http://127.0.0.1:' + this.server.address().port;
      const send = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: 'Local launcher requests only' });
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(PAGE);
      }
      if (req.method === 'GET' && req.url === '/api/status') return send(200, this.status());
      if (req.method !== 'POST' || !['/api/start', '/api/stop'].includes(req.url))
        return send(404, { error: 'Not found' });
      if (
        req.headers.origin !== origin ||
        !(req.headers['content-type'] || '').startsWith('application/json')
      )
        return send(403, { error: 'Same-origin JSON request required' });
      let size = 0,
        chunks = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) return send(413, { error: 'Request too large' });
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        send(200, req.url === '/api/start' ? await this.start(value) : await this.stop());
      } catch (error) {
        send(400, { error: error.message });
      }
    });
    this.server.listen(port, '127.0.0.1');
    await once(this.server, 'listening');
    return 'http://127.0.0.1:' + this.server.address().port;
  }
  async close() {
    await this.stop();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidStream native launcher</title>
<style>body{font:15px system-ui;background:#171719;color:#eee;max-width:760px;margin:32px auto;padding:0 18px}label{display:block;margin:14px 0}input:not([type=checkbox]){box-sizing:border-box;display:block;width:100%;padding:10px;margin-top:5px;background:#29292e;color:inherit;border:1px solid #666;border-radius:7px}button,a{display:inline-block;padding:10px 14px;margin:5px 8px 5px 0;color:inherit;background:#383244;border:1px solid #8e789e;border-radius:8px}pre{white-space:pre-wrap;max-height:260px;overflow:auto;background:#222228;padding:12px}small,p{line-height:1.5;color:#ccc}#message{color:#ffcd88}</style>
<h1>VidStream</h1><p>Native server launcher · the same gallery, using this computer's installed tools.</p><p id="hardware"></p><p id="tools"></p><p id="note"></p>
<form id="config"><label>Media folder<input name="mediaDir" required></label><label>Persistent data folder<input name="dataDir" required></label><label>Rebuildable cache folder<input name="cacheDir" required></label><label>Original archive outside media<input name="originalsDir" required></label><label>Server port<input name="port" type="number" min="1024" max="65535" required></label><label><input name="allowLan" type="checkbox"> Allow devices on the local network to connect</label><button id="start">Start server</button><button type="button" id="stop">Stop server</button><a id="open" target="_blank" rel="noopener">Open gallery</a></form>
<p id="message" role="status"></p><h2>Server log</h2><pre id="logs"></pre><p>No software is installed by this launcher. Keep Docker stopped while running the native server. Closing this browser tab does not stop the server; use Stop server or quit the launcher.</p>
<script>let initialized=false;const form=document.querySelector('#config'),message=document.querySelector('#message');
function paint(s){if(!initialized){for(const k of ['mediaDir','dataDir','cacheDir','originalsDir','port'])form.elements[k].value=s.config[k];form.elements.allowLan.checked=s.config.allowLan;initialized=true;}const active=s.state!=='stopped';document.querySelector('#start').disabled=active;document.querySelector('#stop').disabled=!active;document.querySelector('#open').href=s.url;document.querySelector('#open').style.display=s.state==='running'?'inline-block':'none';document.querySelector('#hardware').textContent=s.hardware.platform+' '+s.hardware.architecture+' · '+s.hardware.ramGiB+' GiB RAM · '+s.hardware.threads+' CPU threads · Node '+s.hardware.node;document.querySelector('#tools').textContent=s.dependencies.map(t=>t.name+': '+(t.available?'ready':'missing')).join(' · ');document.querySelector('#note').textContent=s.note;document.querySelector('#logs').textContent=s.logs.map(l=>l.at+' '+l.text).join('\\n');if(s.error)message.textContent=s.error;}
async function refresh(){try{paint(await(await fetch('/api/status')).json());}catch(e){message.textContent=e.message;}}
async function action(url,data){try{message.textContent='Working…';const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),s=await r.json();if(!r.ok)throw Error(s.error);message.textContent=s.state;paint(s);}catch(e){message.textContent=e.message;}}
form.onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));data.allowLan=form.elements.allowLan.checked;action('/api/start',data);};document.querySelector('#stop').onclick=()=>action('/api/stop',{});refresh();setInterval(refresh,2000);</script></html>`;

async function main() {
  const launcher = new NativeLauncher(),
    url = await launcher.listen();
  console.log('VidStream launcher: ' + url);
  if (process.argv.includes('--open')) {
    const command =
      process.platform === 'darwin'
        ? ['open', url]
        : process.platform === 'win32'
          ? ['cmd', '/c', 'start', '', url]
          : ['xdg-open', url];
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  }
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await launcher.close();
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      stopping = false;
    }
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { NativeLauncher, nodeSupported, validateConfig, cleanLog };
