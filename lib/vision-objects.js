'use strict';
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'vision', 'object_worker.py');
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESTART_ATTEMPTS = 2;

let workerState = null;
let restartAttempts = 0;

function spawnWorker(cfg) {
  const proc = spawn('python3', [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, STREAM_MODEL_PATH: cfg.objectModelPath || '', STREAM_DEVICE: cfg.objectDevice || 'auto' },
  });
  const rl = readline.createInterface({ input: proc.stdout });

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let readyDecided = false;
  const readyTimer = setTimeout(() => {
    if (!readyDecided) { readyDecided = true; resolveReady(false); }
  }, READY_TIMEOUT_MS);

  const pending = [];

  rl.on('line', (line) => {
    if (!readyDecided) {
      readyDecided = true;
      clearTimeout(readyTimer);
      resolveReady(line.trim() === 'READY');
      return;
    }
    const waiter = pending.shift();
    if (!waiter) return;
    try {
      waiter.resolve(JSON.parse(line));
    } catch {
      waiter.resolve({ error: 'invalid worker response' });
    }
  });

  proc.stderr.on('data', () => { });

  proc.on('exit', () => {
    if (!readyDecided) { readyDecided = true; clearTimeout(readyTimer); resolveReady(false); }
    while (pending.length) pending.shift().resolve({ error: 'worker exited' });
    if (workerState && workerState.proc === proc) workerState = null;
  });

  return { proc, rl, ready, pending };
}

function getWorker(cfg) {
  if (workerState) return workerState;
  if (restartAttempts > MAX_RESTART_ATTEMPTS) return null;
  restartAttempts++;
  workerState = spawnWorker(cfg);
  return workerState;
}

async function detectObjects(imagePath, cfg) {
  if (!cfg.enableObjectDetection) return [];

  const worker = getWorker(cfg);
  if (!worker) return [];

  const isReady = await worker.ready;
  if (!isReady) return [];

  const prevQueueTail = worker._tail || Promise.resolve();
  const thisRequest = prevQueueTail.then(() => runOne(worker, imagePath));
  worker._tail = thisRequest.catch(() => {});
  const result = await thisRequest;
  return result;
}

function runOne(worker, imagePath) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = worker.pending.indexOf(waiter);
      if (idx !== -1) worker.pending.splice(idx, 1);
      resolve([]);
    }, REQUEST_TIMEOUT_MS);

    const waiter = {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data && Array.isArray(data.objects) ? data.objects : []);
      },
    };
    worker.pending.push(waiter);
    try {
      worker.proc.stdin.write(JSON.stringify({ path: imagePath }) + '\n');
    } catch {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

function shutdown() {
  if (workerState && workerState.proc) {
    try { workerState.proc.kill(); } catch { }
  }
  workerState = null;
  restartAttempts = 0;
}

module.exports = { detectObjects, shutdown };
