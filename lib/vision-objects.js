'use strict';
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'vision', 'object_worker.py');
const READY_TIMEOUT_MS = 30_000; // model load can legitimately take a few seconds
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESTART_ATTEMPTS = 2;

// Module-level so the worker (and its loaded model) is shared and
// reused across every photo/video processed in this server's
// lifetime, not respawned per file.
let workerState = null; // { proc, rl, ready: Promise<boolean>, queue: Promise }
let restartAttempts = 0;

function spawnWorker() {
  const proc = spawn('python3', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: proc.stdout });

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let readyDecided = false;
  const readyTimer = setTimeout(() => {
    if (!readyDecided) { readyDecided = true; resolveReady(false); }
  }, READY_TIMEOUT_MS);

  const pending = []; // FIFO of {resolve, reject} for in-flight requests, one at a time

  rl.on('line', (line) => {
    if (!readyDecided) {
      readyDecided = true;
      clearTimeout(readyTimer);
      resolveReady(line.trim() === 'READY');
      return;
    }
    const waiter = pending.shift();
    if (!waiter) return; // stray output; ignore rather than crash
    try {
      waiter.resolve(JSON.parse(line));
    } catch {
      waiter.resolve({ error: 'invalid worker response' });
    }
  });

  proc.stderr.on('data', () => { /* swallowed: python/torch warnings, not actionable here */ });

  proc.on('exit', () => {
    if (!readyDecided) { readyDecided = true; clearTimeout(readyTimer); resolveReady(false); }
    // Anything still queued when the worker dies gets a clean failure
    // instead of hanging forever.
    while (pending.length) pending.shift().resolve({ error: 'worker exited' });
    if (workerState && workerState.proc === proc) workerState = null;
  });

  return { proc, rl, ready, pending };
}

function getWorker() {
  if (workerState) return workerState;
  if (restartAttempts > MAX_RESTART_ATTEMPTS) return null; // gave up for this run
  restartAttempts++;
  workerState = spawnWorker();
  return workerState;
}

// Serializes requests through the single worker (it processes one
// image at a time internally anyway) so stdout lines can be matched
// back to the request that produced them without needing request IDs.
async function detectObjects(imagePath, cfg) {
  if (!cfg.enableObjectDetection) return [];

  const worker = getWorker();
  if (!worker) return [];

  const isReady = await worker.ready;
  if (!isReady) return [];

  const prevQueueTail = worker._tail || Promise.resolve();
  const thisRequest = prevQueueTail.then(() => runOne(worker, imagePath));
  worker._tail = thisRequest.catch(() => {}); // don't let one failure poison the chain
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
    try { workerState.proc.kill(); } catch { /* already gone */ }
  }
  workerState = null;
}

module.exports = { detectObjects, shutdown };
