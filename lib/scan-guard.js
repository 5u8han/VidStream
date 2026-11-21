'use strict';
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const STORAGE_UNRESPONSIVE = 'SCAN_STORAGE_UNRESPONSIVE';

class ScanGuard {
  constructor(shutdown) {
    this.shutdown = shutdown;
    this.operations = new Map();
    this.unsettled = new Set();
  }

  skip(id) {
    const controller = this.operations.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(Object.assign(Error('Skipped by owner. Retry this file in Media repairs.'), { code: 'SCAN_FILE_SKIPPED' }));
    return true;
  }

  async run(timeout, task, onProgress, action) {
    this.shutdown.throwIfAborted();
    if (this.unsettled.size >= 4) {
      // Give killed tools and aborted reads a chance to release their handles.
      await delay(500, null, { signal: this.shutdown });
      if (this.unsettled.size >= 4)
        throw Object.assign(Error('Multiple canceled file operations are still waiting on the operating system. Check the storage and retry the scan.'), { code: STORAGE_UNRESPONSIVE });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([this.shutdown, controller.signal]);
    if (task) {
      task.id = randomUUID();
      task.skippable = true;
      this.operations.set(task.id, controller);
    }
    const timer = setTimeout(() => {
      const label = task?.command || task?.stage || 'Storage';
      controller.abort(Object.assign(Error(label + ' reported no progress for ' + Math.ceil(timeout / 1000) + ' seconds. This operation timed out.'), { code: 'SCAN_TASK_TIMEOUT' }));
    }, timeout);
    const progress = command => {
      if (signal.aborted) return;
      timer.refresh();
      if (task) {
        if (command) task.command = command;
        else delete task.command;
        onProgress?.();
      }
    };
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason); });
    signal.addEventListener('abort', rejectAbort, { once: true });
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action(signal, progress);
    });
    let settled = false;
    const release = () => { settled = true; this.unsettled.delete(work); };
    work.then(release, release);
    try {
      const value = await Promise.race([work, aborted]);
      signal.throwIfAborted();
      return value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
      if (!settled) this.unsettled.add(work);
      if (task) {
        this.operations.delete(task.id);
        task.skippable = false;
        delete task.command;
      }
    }
  }
}

module.exports = { ScanGuard, STORAGE_UNRESPONSIVE };
