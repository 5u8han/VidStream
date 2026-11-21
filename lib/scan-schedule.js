'use strict';

const SETTING = 'scanSchedule';
const MAX_INTERVAL_MINUTES = Math.floor(2_147_483_647 / 60_000);
const FLAGS = ['scanOnStart', 'watchForChanges'];

function valid(key, value) {
  if (FLAGS.includes(key)) return typeof value === 'boolean';
  return key === 'rescanIntervalMinutes' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INTERVAL_MINUTES;
}

class ScanSchedule {
  constructor(cfg, store, scanner) {
    this.cfg = cfg;
    this.store = store;
    this.scanner = scanner;
    this.defaults = {
      scanOnStart: cfg.scanOnStart,
      watchForChanges: cfg.watchForChanges,
      rescanIntervalMinutes: Math.max(0, Math.min(MAX_INTERVAL_MINUTES, cfg.rescanIntervalMinutes || 0)),
    };
    const saved = store.setting(SETTING, {});
    this.overrides = Object.fromEntries(Object.entries(saved || {}).filter(([key, value]) => valid(key, value)));
  }

  settings() {
    return { defaults: this.defaults, overrides: this.overrides,
      effective: { ...this.defaults, ...this.overrides }, maxIntervalMinutes: MAX_INTERVAL_MINUTES };
  }

  update(patch) {
    if (this.stopped) throw Object.assign(Error('The server is stopping.'), { status: 503 });
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Choose scan scheduling options.');
    const next = { ...this.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(this.defaults, key) || (value !== null && !valid(key, value)))
        throw Error('Select a scan option or enter a whole number of minutes from 0 to ' + MAX_INTERVAL_MINUTES + '.');
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.store.setSetting(SETTING, next);
    this.overrides = next;
    this.apply();
    return this.settings();
  }

  start() {
    if (this.stopped) return;
    this.started = true;
    this.apply();
  }

  apply() {
    if (!this.started) return;
    const { effective } = this.settings();
    this.cfg.watchForChanges = effective.watchForChanges;
    if (effective.watchForChanges) this.scanner.startWatching();
    else this.scanner.stopFileWatching();
    const minutes = effective.rescanIntervalMinutes;
    if (this.timerMinutes === minutes) return;
    clearInterval(this.timer);
    this.timer = null;
    this.timerMinutes = minutes;
    if (minutes > 0) this.timer = setInterval(() => {
      this.scanner.scan().catch(error => this.scanner.warn('SCAN_INTERVAL_FAILED', 'Scheduled scan failed: ' + error.message));
    }, minutes * 60 * 1000).unref();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    clearInterval(this.timer);
  }
}

module.exports = { ScanSchedule };
