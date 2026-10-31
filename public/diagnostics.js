(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamDiagnostics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var measuring = false;
  // Passive timings are bounded and contain no filenames, searches or paths.
  // The first thumbnail/frame stop observing once measured; catalog timings
  // reuse requests the gallery already makes rather than adding polling.
  function createMeasurements(clock) {
    clock =
      clock ||
      function () {
        return performance.now();
      };
    var firstThumbnail = null,
      firstFrame = null,
      catalog = [];
    return {
      thumbnail: function () {
        if (firstThumbnail === null) firstThumbnail = Math.max(0, clock());
      },
      frame: function (elapsed, method) {
        if (firstFrame === null && Number.isFinite(elapsed) && elapsed >= 0)
          firstFrame = { elapsedMs: elapsed, method: method };
      },
      catalog: function (started, status) {
        var finished = clock();
        if (!Number.isFinite(started) || started > finished) return;
        catalog.push({ durationMs: finished - started, finishedAtMs: finished, status: status });
        if (catalog.length > 10) catalog.shift();
      },
      snapshot: function () {
        return {
          firstVisibleLoadedThumbnailMs: firstThumbnail,
          firstPlayerFrame: firstFrame && Object.assign({}, firstFrame),
          recentCatalogResponses: catalog.map(function (entry) {
            return Object.assign({}, entry);
          })
        };
      }
    };
  }
  var measurements = createMeasurements(),
    thumbnailObserver = null;
  function thumbnailLoaded(img) {
    if (measurements.snapshot().firstVisibleLoadedThumbnailMs !== null) return;
    function visible() {
      if (!img.isConnected || document.hidden || !img.complete || !img.naturalWidth) return false;
      var box = img.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth
      );
    }
    if (visible()) {
      measurements.thumbnail();
      if (thumbnailObserver) {
        thumbnailObserver.disconnect();
        thumbnailObserver = null;
      }
    } else if (typeof IntersectionObserver === 'function') {
      if (!thumbnailObserver)
        thumbnailObserver = new IntersectionObserver(function (entries) {
          entries.some(function (entry) {
            if (
              entry.isIntersecting &&
              !document.hidden &&
              entry.target.complete &&
              entry.target.naturalWidth
            ) {
              measurements.thumbnail();
              thumbnailObserver.disconnect();
              thumbnailObserver = null;
              return true;
            }
            return false;
          });
        });
      thumbnailObserver.observe(img);
    }
  }
  function trackPlayer(video) {
    if (measurements.snapshot().firstPlayerFrame !== null) return function () {};
    var started = performance.now(),
      callback = null,
      stopped = false;
    function cleanup() {
      if (stopped) return;
      stopped = true;
      if (callback !== null && video.cancelVideoFrameCallback)
        video.cancelVideoFrameCallback(callback);
      video.removeEventListener('playing', fallback);
    }
    function record(method) {
      if (stopped) return;
      if (!document.hidden) measurements.frame(performance.now() - started, method);
      cleanup();
    }
    function fallback() {
      record('playing-event fallback; frame presentation unavailable');
    }
    if (video.requestVideoFrameCallback)
      callback = video.requestVideoFrameCallback(function () {
        record('presented-frame callback');
      });
    else video.addEventListener('playing', fallback, { once: true });
    return cleanup;
  }
  function summarize(intervals, elapsed) {
    var sorted = intervals.slice().sort(function (a, b) {
      return a - b;
    });
    return {
      pageCallbackFps: elapsed > 0 ? (intervals.length * 1000) / elapsed : null,
      p95FrameIntervalMs: sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : null,
      framesOver25Ms: intervals.filter(function (n) {
        return n > 25;
      }).length
    };
  }
  function open(options) {
    if (measuring) return;
    measuring = true;
    var status = document.createElement('div');
    status.className = 'diagnostic-sampling';
    status.textContent = 'Measuring playback for 6 seconds. Scroll and browse normally…';
    document.body.appendChild(status);
    var start = performance.now(),
      last = start,
      intervals = [],
      frame,
      hidden = document.hidden,
      stops = [];
    function visibility() {
      if (document.hidden) hidden = true;
    }
    document.addEventListener('visibilitychange', visibility);
    var videos = options.videos().map(function (video) {
      var item = video._streamItem || video.closest('.tile')?._item || {},
        tech = item.info?.tech || {},
        rates = [];
      var entry = {
        filename: item.filename || 'Video',
        sourceFps:
          Number(video.dataset.sourceFps) ||
          (video.src.includes('/preview') ? tech.previewFrameRate : tech.frameRate) ||
          null,
        width: video.videoWidth,
        height: video.videoHeight,
        rate: video.playbackRate
      };
      stops.push(
        window.StreamPlayerStats.start(video, function (sample) {
          if (sample.fps !== null) rates.push(sample.fps);
          entry.dropped = sample.dropped;
          entry.totalFrames = sample.total;
          entry.fpsKind = sample.fpsKind;
        })
      );
      entry._rates = rates;
      return entry;
    });
    function tick(now) {
      intervals.push(now - last);
      last = now;
      if (document.hidden) hidden = true;
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    setTimeout(function () {
      cancelAnimationFrame(frame);
      stops.forEach(function (stop) {
        stop();
      });
      status.remove();
      measuring = false;
      document.removeEventListener('visibilitychange', visibility);
      var result = Object.assign(
        {
          measuredAt: new Date().toISOString(),
          durationMs: performance.now() - start,
          valid: !hidden,
          devicePixelRatio: window.devicePixelRatio,
          viewport: [innerWidth, innerHeight],
          previewLimit: options.previewLimit,
          effects: options.effects
        },
        summarize(intervals, performance.now() - start)
      );
      result.previewResources = options.previewStats();
      result.videos = videos.map(function (entry) {
        entry.presentedFps = entry._rates.length
          ? entry._rates.reduce(function (a, b) {
              return a + b;
            }, 0) / entry._rates.length
          : null;
        delete entry._rates;
        return entry;
      });
      result.browserMemory = performance.memory
        ? {
            usedBytes: performance.memory.usedJSHeapSize,
            limitBytes: performance.memory.jsHeapSizeLimit
          }
        : null;
      result.passiveTimings = measurements.snapshot();
      result.note =
        (hidden ? 'Tab became hidden; repeat with the tab visible. ' : '') +
        'Page callback FPS describes browser scheduling, not physical display output. Video FPS uses presented-frame callbacks when supported; memory is only the JS heap where available. Thumbnail time starts at page navigation; player time starts when its source is assigned. Catalog response times include network, server work and JSON parsing; browse during processing to compare busy-server behavior. Missing measurements remain null.';
      show(result);
    }, 6000);
  }
  function show(result) {
    var dialog = document.createElement('dialog');
    dialog.className = 'stream-settings';
    dialog.setAttribute('aria-label', 'Playback diagnostics');
    function node(tag, text) {
      var el = document.createElement(tag);
      el.textContent = text;
      dialog.appendChild(el);
      return el;
    }
    node('h2', 'Playback diagnostics');
    node(
      'p',
      result.valid
        ? 'Measured while the page was visible.'
        : 'The measurement was interrupted by a hidden tab.'
    );
    node('p', result.note);
    var text = JSON.stringify(result, null, 2),
      output = node('textarea', '');
    output.value = text;
    output.readOnly = true;
    output.rows = 14;
    output.style.width = '100%';
    output.setAttribute('aria-label', 'Copyable diagnostic results');
    var copy = node('button', 'Copy results'),
      message = node('p', '');
    message.setAttribute('role', 'status');
    copy.onclick = async function () {
      try {
        if (!navigator.clipboard?.writeText) throw Error();
        await navigator.clipboard.writeText(text);
        message.textContent = 'Copied.';
      } catch (_) {
        output.focus();
        output.select();
        message.textContent = 'Results selected. Use your browser’s Copy action.';
      }
    };
    function close() {
      if (window.StreamNavigation?.has('diagnostics')) window.StreamNavigation.back();
      else dialog.close();
    }
    node('button', 'Close').onclick = close;
    dialog.addEventListener('cancel', function (e) {
      e.preventDefault();
      close();
    });
    dialog.addEventListener('close', function () {
      if (window.StreamNavigation?.has('diagnostics')) window.StreamNavigation.leave('diagnostics');
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    window.StreamNavigation?.enter('diagnostics', {
      back: function () {
        dialog.close();
      },
      forward: function () {
        dialog.showModal();
      }
    });
  }
  return {
    open: open,
    summarize: summarize,
    createMeasurements: createMeasurements,
    thumbnailLoaded: thumbnailLoaded,
    trackPlayer: trackPlayer,
    catalogResponse: function (started, status) {
      measurements.catalog(started, status);
    },
    snapshot: function () {
      return measurements.snapshot();
    }
  };
});
