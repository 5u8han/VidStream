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
      warm = new Set(),
      refillFrame = null;
    var raf = options.raf || requestAnimationFrame,
      caf = options.caf || cancelAnimationFrame;
    function notify() {
      if (options.onChange) options.onChange(running.size);
    }
    function release(tile) {
      warm.delete(tile);
      var wasRunning = running.delete(tile);
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
      if (wasRunning) notify();
    }
    function trimWarm() {
      while (warm.size > 8) release(warm.values().next().value);
    }
    function trimTracked() {
      var limit = options.limit() + 8;
      for (var tile of tracked) {
        if (tracked.size <= limit) break;
        if (!running.has(tile)) release(tile);
      }
    }
    function schedule() {
      if (refillFrame === null)
        refillFrame = raf(function () {
          refillFrame = null;
          refill();
        });
    }
    function pause(tile) {
      var wasRunning = running.delete(tile);
      var video = tile._video;
      if (video) {
        video._previewAttempt = null;
        video.pause();
        if (!inView.has(tile)) {
          if (tile.isConnected && video.readyState >= 2 && video.getAttribute('src') === tile._item.urls.preview) {
            warm.delete(tile);
            warm.add(tile);
            trimWarm();
          } else release(tile);
        }
      }
      if (wasRunning) notify();
      if (!options.blocked() && options.enabled()) schedule();
    }
    function play(tile) {
      var limit = options.limit();
      if (
        !options.enabled() ||
        options.blocked() ||
        limit < 1 ||
        !tile.isConnected ||
        tile._item.type !== 'video' ||
        running.has(tile)
      )
        return;
      var source = options.source(tile._item);
      if (!source) return;
      if (running.size >= limit) {
        if (!tile.matches(':hover')) return;
        var victim =
          Array.from(running).find(function (entry) {
            return !entry.matches(':hover');
          }) || running.values().next().value;
        if (victim) pause(victim);
      }
      warm.delete(tile);
      tracked.add(tile);
      var video = options.attach(tile, tile._item, source);
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
      trimTracked();
      notify();
      var attempt = Symbol();
      video._previewAttempt = attempt;
      var promise = video.play();
      if (promise && promise.catch)
        promise.catch(function () {
          if (tile._video !== video || video._previewAttempt !== attempt) return;
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
        if (!tile._video?.error) play(tile);
      }
    }
    function setVisible(tile, visible) {
      if (visible) {
        inView.add(tile);
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
      suspend: function () {
        if (refillFrame !== null) caf(refillFrame);
        refillFrame = null;
        Array.from(running).forEach(pause);
      },
      trim: trimTracked,
      clear: clear,
      stats: function () {
        return {
          running: running.size,
          visible: inView.size,
          retained: tracked.size,
          warm: warm.size
        };
      }
    };
  }
  return { create: create };
});
