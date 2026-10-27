'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { run } = require('./exec');
const { shutdown } = require('./vision-objects');

// Only trusted, predefined model names are accepted by the download endpoint.
// Model weights are optional and never fetched during normal gallery browsing.
const MODELS = Object.freeze({
  yolov8n: { label: 'YOLOv8 nano', weights: 'yolov8n.pt', note: 'Fastest / least memory' },
  yolov8s: { label: 'YOLOv8 small', weights: 'yolov8s.pt', note: 'Balanced accuracy and speed' },
  yolov8m: { label: 'YOLOv8 medium', weights: 'yolov8m.pt', note: 'More accurate; more RAM/VRAM' },
});
const DEVICES = new Set(['auto', 'cpu', 'cuda:0']);

class AiManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.modelsDir = path.join(cfg.cacheDir, 'models');
    this.settingsPath = path.join(cfg.cacheDir, 'ai-settings.json');
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
    this.cfg.enableObjectDetection = this.enabled && this.installed(this.selected);
    this.cfg.objectModelPath = this.weightPath();
    this.cfg.objectDevice = this.device;
    shutdown(); // a changed model/device must restart the persistent worker
  }
  installed(name) {
    try { return fs.statSync(this.weightPath(name)).size > 1024; }
    catch { return false; }
  }
  save() {
    fs.mkdirSync(this.cfg.cacheDir, { recursive: true });
    fs.writeFileSync(this.settingsPath + '.tmp', JSON.stringify({
      selected: this.selected, device: this.device, enabled: this.enabled,
    }));
    fs.renameSync(this.settingsPath + '.tmp', this.settingsPath);
    this.sync();
  }
  status() {
    return {
      selected: this.selected, device: this.device, enabled: this.enabled,
      effective: this.cfg.enableObjectDetection,
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
      // Downloads only a named Ultralytics release preset. The user opts in.
      // Ultralytics and torch must be installed via the optional AI Docker build.
      const script = `import os, sys\nfrom ultralytics import YOLO\nos.chdir(sys.argv[2])\nYOLO(sys.argv[1])\n`;
      await run('python3', ['-c', script, MODELS[id].weights, this.modelsDir], { timeout: 300000 });
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
  return {
    cpu: os.cpus()[0] ? os.cpus()[0].model : 'Unknown',
    threads: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    detectedMemoryGiB: Math.round(visibleMemoryBytes() / 1073741824 * 10) / 10,
    gpu,
    gpuNote: gpu.length ? 'GPU visible inside Stream container' : 'No NVIDIA GPU visible inside Stream container; GPU passthrough may not be configured',
  };
}

module.exports = { AiManager, hardwareSummary };
