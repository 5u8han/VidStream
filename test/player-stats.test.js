'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const api = require('../public/player-stats');

function fixture(frameCallbacks = true, counters = true) {
  let time = 0, timer = null, callback = null, nextId = 1, total = 0, dropped = 0;
  const samples = [], videoListeners = new Map(), documentListeners = new Map();
  const doc = { hidden: false, addEventListener: (n, f) => documentListeners.set(n, f), removeEventListener: n => documentListeners.delete(n) };
  const video = {
    ownerDocument: doc, currentSrc: 'original.mp4', paused: false, ended: false, seeking: false, readyState: 4,
    playbackRate: 1, videoWidth: 1920, videoHeight: 1080, currentTime: 5,
    buffered: { length: 2, start: i => i === 0 ? 0 : 30, end: i => i === 0 ? 20 : 40 },
    addEventListener: (n, f) => videoListeners.set(n, f), removeEventListener: n => videoListeners.delete(n),
  };
  if (counters) video.getVideoPlaybackQuality = () => ({ totalVideoFrames: total, droppedVideoFrames: dropped });
  if (frameCallbacks) {
    video.requestVideoFrameCallback = f => { callback = f; return nextId++; };
    video.cancelVideoFrameCallback = () => { callback = null; };
  }
  const context = { window: {}, performance: { now: () => time }, setInterval: f => { timer = f; return 1; }, clearInterval: () => { timer = null; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/player-stats.js'), 'utf8'), context);
  const stop = context.window.StreamPlayerStats.start(video, sample => samples.push(sample));
  return {
    video, doc, samples, stop,
    get callbacks() { return { timer, frame: callback, video: videoListeners.size, document: documentListeners.size }; },
    frame(at, count) { time = at; const f = callback; callback = null; if (f) f(at, { presentedFrames: count }); },
    tick(at, all, lost = 0) { time = at; total = all; dropped = lost; if (timer) timer(); return samples.at(-1); },
    event(name) { videoListeners.get(name)?.(); },
    visibility(hidden) { doc.hidden = hidden; documentListeners.get('visibilitychange')?.(); },
  };
}

test('player stats exports start and uses presented frames rather than decoded totals for FPS', () => {
  assert.equal(typeof api.start, 'function');
  const f = fixture();
  f.frame(0, 1); f.frame(1000, 61);
  const sample = f.tick(1000, 90, 15);
  assert.equal(sample.fps, 60);
  assert.equal(sample.fpsKind, 'presented');
  assert.equal(sample.total, 90);
  assert.equal(sample.dropped, 15);
  assert.equal(sample.bufferedSeconds, 15);
  assert.equal(sample.state, 'playing');
  assert.equal(sample.width, 1920);
  f.stop();
});

test('fallback subtracts dropped frames and unavailable counters stay unavailable', () => {
  const f = fixture(false);
  const sample = f.tick(1000, 60, 12);
  assert.equal(sample.fps, 48);
  assert.equal(sample.fpsKind, 'estimated');
  f.stop();
  const missing = fixture(false, false);
  const unavailable = missing.tick(1000, 60);
  assert.equal(unavailable.fps, null);
  assert.equal(unavailable.total, null);
  assert.equal(unavailable.dropped, null);
  missing.stop();
});

test('pause, seeking, visibility and new sources reset frame-rate baselines', () => {
  const f = fixture();
  f.frame(0, 1); f.frame(1000, 61); assert.equal(f.tick(1000, 61).fps, 60);
  f.video.paused = true; f.event('pause');
  assert.equal(f.tick(6000, 61).fps, null);
  assert.equal(f.samples.at(-1).state, 'paused');
  f.video.paused = false; f.event('playing');
  f.frame(6000, 62); f.frame(7000, 122); assert.equal(f.tick(7000, 122).fps, 60);
  f.video.seeking = true; f.event('seeking'); assert.equal(f.tick(8000, 122).fps, null);
  assert.equal(f.samples.at(-1).state, 'seeking');
  f.video.seeking = false; f.event('seeked'); f.frame(8000, 123);
  f.visibility(true); assert.equal(f.callbacks.frame, null); assert.equal(f.tick(18000, 123).fps, null);
  f.visibility(false); f.frame(18000, 124); f.frame(19000, 184); assert.equal(f.tick(19000, 184).fps, 60);
  f.video.currentSrc = 'enhanced.mp4';
  assert.equal(f.tick(20000, 0).fps, null);
  f.frame(20000, 1); f.frame(21000, 61); assert.equal(f.tick(21000, 61).fps, 60);
  f.stop();
});

test('stopping stats cancels all scheduled work and event listeners', () => {
  const f = fixture(), count = f.samples.length;
  assert.ok(f.callbacks.frame);
  assert.equal(typeof f.callbacks.timer, 'function');
  f.stop(); f.stop();
  assert.deepEqual(f.callbacks, { timer: null, frame: null, video: 0, document: 0 });
  f.frame(1000, 60); f.tick(1000, 60);
  assert.equal(f.samples.length, count);
});
