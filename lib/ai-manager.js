'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { run } = require('./exec');
const { shutdown } = require('./vision-objects');

// Only trusted, predefined model names are accepted by the download endpoint.
// Model weights are optional and never fetched during normal gallery browsing.
const MODEL_REPOS = {
  yolov8: { repo:'Ultralytics/YOLOv8', revision:'27f858f2dc238503a66ce10248cf7ec71a3ded5d' },
  yolo11: { repo:'Ultralytics/YOLO11', revision:'8b8ac7d1fae7468f85dbf89670dd66f41f485aab' },
};
const MODELS = Object.freeze(Object.fromEntries(Object.entries(MODEL_REPOS).flatMap(([family, source]) =>
  [['n','nano'],['s','small'],['m','medium'],['l','large'],['x','extra large']].map(([size,label]) => {
    const id = family + size;
    return [id, { label:family.toUpperCase() + ' ' + label, weights:id + '.pt',
      note: size === 'n' ? 'Fastest / least memory' : size === 's' ? 'Balanced' : 'Higher memory and compute requirements',
      ...source, source:'Hugging Face · official Ultralytics', license:'AGPL-3.0 / Ultralytics enterprise' }];
  }))));
const DEVICES = new Set(['auto', 'cpu', 'cuda:0']);

class AiManager {
  constructor(cfg) {
    this.cfg = cfg;
    const runtime = spawnSync('python3', ['-c', 'import importlib.util; print(bool(importlib.util.find_spec("ultralytics")))'], {encoding:'utf8',timeout:5000});
    this.runtimeAvailable = runtime.status === 0 && runtime.stdout.trim() === 'True';
    this.cudaAvailable = this.runtimeAvailable && spawnSync('python3', ['-c', 'import torch; print(torch.cuda.is_available())'], {encoding:'utf8',timeout:10000}).stdout?.trim() === 'True';
    this.modelsDir = path.join(cfg.cacheDir, 'models');
    this.settingsPath = path.join(cfg.dataDir || cfg.cacheDir, 'ai-settings.json');
    if (!fs.existsSync(this.settingsPath) && cfg.dataDir && fs.existsSync(path.join(cfg.cacheDir, 'ai-settings.json'))) {
      fs.mkdirSync(cfg.dataDir, {recursive:true}); fs.copyFileSync(path.join(cfg.cacheDir, 'ai-settings.json'), this.settingsPath);
    }
    this.selected = 'yolov8n';
    this.device = 'auto';
    this.enabled = cfg.enableObjectDetection === true;
    this.installing = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      if (MODELS[saved.selected]) this.selected = saved.selected;
      if (DEVICES.has(saved.device)) this.device = saved.device;
      this.enabled = saved.enabled === true;
    } catch { /* first run */ }
    this.sync();
  }
  weightPath(name = this.selected) {
    return path.join(this.modelsDir, MODELS[name].weights);
  }
  sync() {
    this.cfg.enableObjectDetection = this.enabled && this.installed(this.selected) && this.runtimeAvailable;
    this.cfg.objectModelPath = this.weightPath();
    this.cfg.objectDevice = this.device === 'cuda:0' && !this.cudaAvailable ? 'cpu' : this.device;
    shutdown(); // a changed model/device must restart the persistent worker
  }
  installed(name) {
    try { return fs.statSync(this.weightPath(name)).size > 1024; }
    catch { return false; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath + '.tmp', JSON.stringify({
      selected: this.selected, device: this.device, enabled: this.enabled,
    }));
    fs.renameSync(this.settingsPath + '.tmp', this.settingsPath);
    this.sync();
  }
  status() {
    return {
      modelsDir: this.modelsDir, inferenceAvailable:this.runtimeAvailable,
      selected: this.selected, device: this.device, enabled: this.enabled,
      effective: this.cfg.enableObjectDetection, effectiveDevice:this.cfg.objectDevice,
      deviceNote:this.device==='cuda:0'&&!this.cudaAvailable?'Saved GPU preference retained; using CPU because CUDA is unavailable on this server':null,
      installing: this.installing,
      models: Object.entries(MODELS).map(([id, info]) => ({ id, ...info,
        installed: this.installed(id),
        bytes: this.installed(id) ? fs.statSync(this.weightPath(id)).size : 0,
      })),
    };
  }
  update(body) {
    if (body.selected !== undefined) {
      if (!MODELS[body.selected]) throw Error('Invalid model preset');
      this.selected = body.selected;
    }
    if (body.device !== undefined) {
      if (!DEVICES.has(body.device)) throw Error('Invalid compute device');
      this.device = body.device;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw Error('enabled must be true or false');
      this.enabled = body.enabled;
    }
    this.save();
    return this.status();
  }
  async install(id) {
    if (!MODELS[id]) throw Error('Invalid model preset');
    if (this.installing) throw Error('A model installation is already in progress');
    if (this.installed(id)) return this.status();
    this.installing = id;
    fs.mkdirSync(this.modelsDir, { recursive: true });
    try {
      const model = MODELS[id];
      const response = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.weights}`, {signal:AbortSignal.timeout(300000)});
      if (!response.ok) throw Error('Hugging Face download failed: ' + response.status);
      const { Readable, Transform } = require('node:stream');
      const { pipeline } = require('node:stream/promises');
      let bytes = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 512 * 1024 * 1024 ? Error('Model exceeds 512 MiB download limit') : null, chunk);
      }});
      const temporary = this.weightPath(id) + '.' + require('node:crypto').randomUUID() + '.download';
      try {
        await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(temporary, {flags:'wx'}));
        if (bytes < 1024) throw Error('Downloaded weights are incomplete');
        fs.renameSync(temporary, this.weightPath(id));
      } finally { try { fs.unlinkSync(temporary); } catch {} }
      this.sync();
      if (!this.installed(id)) throw Error('Model download finished but weights were not written');
      return this.status();
    } finally {
      this.installing = null;
    }
  }
}

function gpuProbe() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2500, maxBuffer: 8192 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).trim().split('\n').filter(Boolean).map((line) => {
          const parts = line.split(',').map((v) => v.trim());
          return { name: parts[0], totalVramMiB: Number(parts[1]) || null, freeVramMiB: Number(parts[2]) || null };
        }));
      });
  });
}

function visibleMemoryBytes() {
  const hostBytes = os.totalmem();
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const bytes = Number(raw);
      if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < hostBytes) return bytes;
    } catch { /* cgroup file not present on this host */ }
  }
  return hostBytes;
}

async function hardwareSummary() {
  const gpu = await gpuProbe();
  if(!gpu.length&&process.platform==='darwin'&&process.arch==='arm64')gpu.push({name:'Apple Silicon GPU (native macOS)',totalVramMiB:null,freeVramMiB:null,unifiedMemory:true});
  return {
    cpu: os.cpus()[0] ? os.cpus()[0].model : 'Unknown',
    threads: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    detectedMemoryGiB: Math.round(visibleMemoryBytes() / 1073741824 * 10) / 10,
    gpu,
    gpuNote: gpu.length ? 'GPU detected on the server; Apple GPU uses unified system memory' : 'No NVIDIA GPU visible inside Stream container; GPU passthrough may not be configured',
  };
}

module.exports = { AiManager, hardwareSummary };
