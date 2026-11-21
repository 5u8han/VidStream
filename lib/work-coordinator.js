'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const PRESETS = Object.freeze({ browse: 1, balanced: 2, process: 4 });
const PRIORITIES = {
  playback: 0,
  poster: 10,
  preview: 20,
  metadata: 30,
  analysis: 40
};
const FOREGROUND_PRIORITY = 15;
const RETIRED_KINDS = new Set(['enhancement', 'export', 'publish', 'restore', 'recovery']);

class WorkCoordinator {
  constructor(store, { scanWorkers, onIssue = () => {} } = {}) {
    this.store = store;
    this.onIssue = onIssue;
    this.capacity = scanWorkers ? { browse: 1, balanced: Math.max(1, Math.ceil(scanWorkers / 2)), process: scanWorkers } : PRESETS;
    this.pending = [];
    this.active = new Map();
    this.stopped = false;
    this.context = new AsyncLocalStorage();
    this.preset = store.setting('workPreset', 'balanced');
    if (!Object.hasOwn(PRESETS, this.preset)) this.preset = 'balanced';
    store.sql.exec(
      'CREATE TABLE IF NOT EXISTS work_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)'
    );
    for (const row of store.sql.prepare(
      "SELECT data FROM work_tasks WHERE json_extract(data,'$.state') IN ('running','queued')"
    ).all()) {
      const task = JSON.parse(row.data);
      if (RETIRED_KINDS.has(task.kind)) continue;
      this.onIssue({ code: 'BACKGROUND_TASK_INTERRUPTED', path: task.path, stage: task.kind, message: 'This operation was interrupted by a server restart.' });
      this.save({
        ...task,
        state: 'interrupted',
        error: 'Server stopped. Retry the owning library operation.'
      });
    }
  }
  save(task) {
    if (task.persistent === false) return;
    task.updatedAt = new Date().toISOString();
    this.store.sql
      .prepare(
        'INSERT INTO work_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(task.id, JSON.stringify(task));
  }
  setPreset(preset) {
    if (!Object.hasOwn(PRESETS, preset)) throw Error('Choose browse, balanced or process');
    this.preset = preset;
    this.store.setSetting('workPreset', preset);
    this.pump();
    return this.status();
  }
  reportFailure(task, error) {
    if (this.stopped || task.persistent === false) return;
    this.onIssue({ level: 'error', code: 'BACKGROUND_TASK_FAILED', path: task.path,
      stage: task.kind, message: String(error.message || error).slice(0, 300) });
  }
  run(kind, label, fn, { path = null, priority = PRIORITIES[kind] ?? 30, heavy = false, identity = null, persistent = true, canStart = null } = {}) {
    if (this.stopped) return Promise.reject(Error('Work coordinator is stopped'));
    if (identity) {
      const existing = [...this.pending, ...this.active.values()].find(
        (work) => work.task.identity === identity
      );
      if (existing) return existing.promise;
    }
    const task = {
      id: crypto.randomUUID(),
      kind,
      label,
      path,
      priority,
      heavy: Boolean(heavy),
      identity,
      ...(persistent ? {} : { persistent: false }),
      state: 'queued',
      createdAt: new Date().toISOString()
    };
    const parent = this.context.getStore();
    if (parent) {
      if (heavy && !parent.heavy)
        return Promise.reject(Error('A light task cannot start nested heavy work'));
      task.parentId = parent.id;
      this.save({ ...task, state: 'running' });
      return Promise.resolve()
        .then(fn)
        .then(
          (result) => {
            this.save({ ...task, state: 'completed' });
            return result;
          },
          (error) => {
            this.reportFailure(task, error);
            this.save({
              ...task,
              state: 'failed',
              error: String(error.message || error).slice(0, 300)
            });
            throw error;
          }
        );
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.save(task);
    this.pending.push({ task, fn, resolve, reject, promise, canStart });
    queueMicrotask(() => this.pump());
    return promise;
  }
  pump() {
    if (this.stopped) return;
    this.pending.sort(
      (a, b) =>
        a.task.priority - b.task.priority || a.task.createdAt.localeCompare(b.task.createdAt)
    );
    while (true) {
      const capacity = this.capacity[this.preset];
      const foregroundOnly = this.active.size >= capacity;
      if (this.active.size >= capacity + 1) return;
      const heavyRunning = [...this.active.values()].some((work) => work.task.heavy);
      const index = this.pending.findIndex(
        (work) =>
          (!work.canStart || work.canStart()) &&
          (!work.task.heavy || !heavyRunning) &&
          (!foregroundOnly || (!work.task.heavy && work.task.priority <= FOREGROUND_PRIORITY))
      );
      if (index < 0) return;
      const work = this.pending.splice(index, 1)[0];
      work.task.startedAt = new Date().toISOString();
      this.active.set(work.task.id, work);
      this.save({ ...work.task, state: 'running' });
      Promise.resolve()
        .then(() => this.context.run({ id: work.task.id, heavy: work.task.heavy }, work.fn))
        .then(
          (result) => {
            this.save({ ...work.task, state: 'completed' });
            work.resolve(result);
          },
          (error) => {
            this.reportFailure(work.task, error);
            this.save({
              ...work.task,
              state: 'failed',
              error: String(error.message || error).slice(0, 300)
            });
            work.reject(error);
          }
        )
        .finally(() => {
          this.active.delete(work.task.id);
          this.pump();
        });
    }
  }
  status() {
    const recent = this.store.sql
      .prepare('SELECT data FROM work_tasks ORDER BY rowid DESC LIMIT 30')
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((task) => !RETIRED_KINDS.has(task.kind));
    return {
      preset: this.preset,
      concurrency: this.capacity[this.preset],
      foregroundAllowance: 1,
      active: [...this.active.values()].map((work) => ({ ...work.task, state: 'running' })),
      queued: this.pending.map((work) => work.task),
      recent,
      note: 'Presets limit background concurrency, with one additional light foreground task for content identity or posters. Only one heavy task runs at a time. Presets do not allocate CPU, RAM or GPU devices.'
    };
  }
  stop() {
    this.stopped = true;
    for (const work of this.pending.splice(0)) {
      this.save({
        ...work.task,
        state: 'interrupted',
        error: 'Server stopped before work started'
      });
      work.reject(Error('Server stopped before work started'));
    }
    return this.drain();
  }
  drain() {
    return Promise.allSettled([...this.active.values()].map((work) => work.promise));
  }
}
module.exports = { WorkCoordinator, PRESETS };
