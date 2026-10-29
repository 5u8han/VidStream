(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamPlayerStats = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function counter(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function quality(video) {
    try {
      if (typeof video.getVideoPlaybackQuality === 'function') {
        var value = video.getVideoPlaybackQuality();
        return { total: counter(value.totalVideoFrames), dropped: counter(value.droppedVideoFrames) };
      }
    } catch (_) { /* Some media implementations expose an unusable method. */ }
    return { total: counter(video.webkitDecodedFrameCount), dropped: counter(video.webkitDroppedFrameCount) };
  }

  function bufferedAhead(video) {
    try {
      for (var i = 0; i < video.buffered.length; i++) {
        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
          return Math.max(0, video.buffered.end(i) - video.currentTime);
        }
      }
    } catch (_) { /* A source may be replaced between reading the ranges. */ }
    return 0;
  }

  function start(video, onSample) {
    var doc = video.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var useFrames = typeof video.requestVideoFrameCallback === 'function';
    var frameId = null, stopped = false, presented = null, baseline = null;
    var source = video.currentSrc || video.src || '';
    var events = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'waiting', 'emptied', 'loadstart', 'loadedmetadata', 'ratechange'];

    function isActive() {
      return !video.paused && !video.ended && !video.seeking && video.readyState >= 3 && !(doc && doc.hidden);
    }
    function checkSource() {
      var current = video.currentSrc || video.src || '';
      if (current !== source) { source = current; baseline = null; presented = null; }
    }
    function cancelFrame() {
      if (frameId !== null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameId);
      frameId = null;
    }
    function queueFrame() {
      if (!stopped && useFrames && frameId === null && isActive()) frameId = video.requestVideoFrameCallback(frame);
    }
    function frame(_now, metadata) {
      frameId = null;
      if (stopped) return;
      checkSource();
      if (isActive()) {
        presented = counter(metadata.presentedFrames);
        if (presented !== null && !baseline) baseline = { count: presented, at: performance.now() };
      } else baseline = null;
      queueFrame();
    }
    function reset() {
      baseline = null; presented = null;
      cancelFrame();
      checkSource();
      queueFrame();
    }
    function sample() {
      if (stopped) return;
      checkSource();
      var q = quality(video), now = performance.now(), fps = null;
      // totalVideoFrames includes frames dropped by the playback pipeline.
      // When frame callbacks are unavailable, subtract dropped frames to make
      // the fallback an estimate of displayed frames rather than decode rate.
      var count = useFrames ? presented : q.total !== null && q.dropped !== null ? Math.max(0, q.total - q.dropped) : null;
      if (isActive() && count !== null) {
        if (baseline && count >= baseline.count && now > baseline.at) fps = (count - baseline.count) * 1000 / (now - baseline.at);
        baseline = { count: count, at: now };
      } else baseline = null;
      var state = video.ended ? 'ended' : video.seeking ? 'seeking' : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing';
      onSample({
        fps: fps,
        fpsKind: useFrames ? 'presented' : 'estimated',
        total: q.total,
        dropped: q.dropped,
        bufferedSeconds: bufferedAhead(video),
        state: state,
        rate: video.playbackRate,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      });
    }

    events.forEach(function (event) { video.addEventListener(event, reset); });
    if (doc) doc.addEventListener('visibilitychange', reset);
    queueFrame();
    sample();
    var timer = setInterval(sample, 1000);
    return function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      cancelFrame();
      events.forEach(function (event) { video.removeEventListener(event, reset); });
      if (doc) doc.removeEventListener('visibilitychange', reset);
      baseline = null;
    };
  }

  return { start: start };
});
