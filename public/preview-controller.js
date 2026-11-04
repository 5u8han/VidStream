(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamPreviewController = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function create(options) {
    var running = new Set(),
      inView = new Set(),
      tracked = new Set(),
      releases = new Map(),
      refillFrame = null;
    var delay = options.releaseMs === undefined ? 2000 : options.releaseMs;
    var raf = options.raf || requestAnimationFrame,
      caf = options.caf || cancelAnimationFrame;
    var later = options.later || setTimeout,
      cancel = options.cancel || clearTimeout;
    function notify() {
      if (options.onChange) options.onChange(running.size);
    }
    function cancelRelease(tile) {
      if (releases.has(tile)) cancel(releases.get(tile));
      releases.delete(tile);
    }
    function release(tile) {
      cancelRelease(tile);
      running.delete(tile);
      tracked.delete(tile);
      var video = tile._video;
      if (video) {
        if (Number.isFinite(video.currentTime)) tile._resumeAt = video.currentTime;
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        tile._video = null;
      }
      notify();
    }
    function scheduleRelease(tile) {
      cancelRelease(tile);
      releases.set(
        tile,
        later(function () {
          releases.delete(tile);
          if (!inView.has(tile) || !tile.isConnected) release(tile);
        }, delay)
      );
    }
    function schedule() {
      if (refillFrame === null)
        refillFrame = raf(function () {
          refillFrame = null;
          refill();
        });
    }
    function pause(tile) {
      running.delete(tile);
      if (tile._video) tile._video.pause();
      if (!inView.has(tile)) scheduleRelease(tile);
      notify();
      schedule();
    }
    function play(tile) {
      if (
        !options.enabled() ||
        options.blocked() ||
        !tile.isConnected ||
        tile._item.type !== 'video' ||
        running.has(tile)
      )
        return;
      if (running.size >= options.limit()) {
        if (!tile.matches(':hover')) return;
        var victim =
          Array.from(running).find(function (entry) {
            return !entry.matches(':hover');
          }) || running.values().next().value;
        if (victim) pause(victim);
      }
      cancelRelease(tile);
      tracked.add(tile);
      var video = options.attach(tile, tile._item);
      if (tile._resumeAt > 0 && !video._resumeBound) {
        video._resumeBound = true;
        var resume = function () {
          try {
            video.currentTime = Math.min(
              tile._resumeAt,
              Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : tile._resumeAt
            );
          } catch (_) {}
        };
        if (video.readyState >= 1) resume();
        else video.addEventListener('loadedmetadata', resume, { once: true });
      }
      running.add(tile);
      notify();
      var promise = video.play();
      if (promise && promise.catch)
        promise.catch(function () {
          // A rejected play() from a discarded element must not clear the
          // slot for a new preview mounted on the same lightweight tile.
          if (tile._video !== video) return;
          running.delete(tile);
          notify();
        });
    }
    function refill() {
      if (options.blocked() || !options.enabled()) return;
      for (var tile of inView) {
        if (!tile.isConnected) {
          inView.delete(tile);
          release(tile);
          continue;
        }
        if (running.size >= options.limit()) break;
        play(tile);
      }
    }
    function setVisible(tile, visible) {
      if (visible) {
        inView.add(tile);
        cancelRelease(tile);
        play(tile);
      } else {
        inView.delete(tile);
        pause(tile);
      }
    }
    function clear() {
      inView.clear();
      Array.from(tracked).forEach(release);
      running.clear();
      releases.forEach(cancel);
      releases.clear();
      if (refillFrame !== null) caf(refillFrame);
      refillFrame = null;
      notify();
    }
    return {
      running: running,
      inView: inView,
      play: play,
      pause: pause,
      refill: refill,
      schedule: schedule,
      setVisible: setVisible,
      release: function (tile) {
        inView.delete(tile);
        release(tile);
        schedule();
      },
      clear: clear,
      stats: function () {
        return {
          running: running.size,
          visible: inView.size,
          retained: tracked.size,
          pendingRelease: releases.size
        };
      }
    };
  }
  return { create: create };
});
