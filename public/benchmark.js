(function (root, factory) {
  'use strict';
  var benchmark = factory();
  if (typeof module === 'object' && module.exports) module.exports = benchmark;
  else root.StreamBenchmark = benchmark;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var GiB = 1024 ** 3;
  var MAX_DOWNLOAD = 4 * 1024 ** 2;
  var PREVIEW_CHOICES = [4, 8, 12, 16, 24];
  var recentReport;

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function rounded(value, places) {
    return finite(value) === null ? null : Number(value.toFixed(places));
  }

  function selectNumbers(source, names) {
    return Object.fromEntries(names.map(function (name) { return [name, finite(source?.[name])]; }));
  }

  function displayNumber(number, suffix) {
    return finite(number) === null ? 'Unavailable' : number.toLocaleString(undefined, { maximumFractionDigits: 1 }) + suffix;
  }

  function size(bytes) {
    if (finite(bytes) === null) return 'Unavailable';
    var unit = ' B';
    for (var next of [' KiB', ' MiB', ' GiB', ' TiB']) {
      if (bytes < 1024) break;
      bytes /= 1024;
      unit = next;
    }
    return displayNumber(bytes, unit);
  }

  function suggestions(host, connection, playback) {
    var measured = finite(host?.preview?.sampleUpperBitsPerSecond);
    var bitrate = measured === null ? null : measured / 1e6;
    var width = finite(host?.preview?.maxWidth) || 480;
    var assumedRate = bitrate === null ? Math.max(1.5, 1.5 * (width / 480) ** 2) : Math.max(1.5, bitrate * 1.25);
    var downstream = finite(connection?.downloadMbps);
    var latency = finite(connection?.medianLatencyMs);
    var estimate = downstream === null ? null : Math.floor(downstream * 0.5 / assumedRate);
    var pause = estimate !== null && estimate < PREVIEW_CHOICES[0];
    var upper = playback?.droppedPercent >= 5 ? 8 : 16;
    if (latency >= 150) upper = Math.min(upper, 8);
    var previews = estimate === null || pause ? null : PREVIEW_CHOICES.findLast(function (choice) {
      return choice <= Math.min(estimate, upper);
    }) || 4;

    var free = finite(host?.cache?.freeBytes);
    var storage = host?.cache?.storage;
    var headroom = free === null || storage !== 'disk' ? null : Math.min(free, Math.max(8 * GiB, Math.ceil(free * 0.25)));
    var available = headroom === null ? null : Math.floor(free - headroom);
    var folders = Array.isArray(host?.library?.folders) ? host.library.folders : [];
    var count = folders.reduce(function (total, entry) { return total + (finite(entry.count) || 0); }, 0);
    var shares = available === null ? [] : folders.map(function (entry, index) {
      var fraction = count && folders.length ? 0.25 / folders.length + 0.75 * (finite(entry.count) || 0) / count : 1 / folders.length;
      return { folder: index + 1, indexedItems: finite(entry.count), additionalBytes: Math.floor(available * fraction) };
    });
    return {
      concurrentOptimizedPreviews: previews,
      pauseAutoplay: pause,
      assumedPreviewMbps: rounded(assumedRate, 2),
      connectionHeadroomFraction: 0.5,
      cacheAdditionalBudgetBytes: available,
      suggestedDiskHeadroomBytes: headroom,
      folderShares: shares
    };
  }

  function sanitize(report) {
    var source = report.host;
    var resources = source?.host;
    var cache = source?.cache;
    var folders = Array.isArray(source?.library?.folders) ? source.library.folders : [];
    return {
      schemaVersion: 1,
      measuredAt: report.measuredAt,
      application: 'VidStream',
      applicationVersion: report.applicationVersion,
      network: report.connection,
      browserPlayback: report.playback,
      host: source ? {
        ...selectNumbers(resources, ['effectiveCores', 'availableThreads', 'logicalThreads', 'effectiveMemoryBytes']),
        containerized: typeof resources?.containerized === 'boolean' ? resources.containerized : null
      } : null,
      cpu: source?.cpu ? selectNumbers(source.cpu, ['elapsedMs', 'iterations']) : null,
      cache: source ? {
        ...selectNumbers(cache, ['freeBytes', 'totalBytes', 'runtimeFreeBytes', 'runtimeTotalBytes', 'sampleBytes', 'writeMiBps', 'warmReadMiBps', 'boundedBytes']),
        storage: ['disk', 'ram', 'unknown'].includes(cache?.storage) ? cache.storage : 'unknown'
      } : null,
      preview: source ? selectNumbers(source.preview, ['durationSeconds', 'maxWidth', 'sampleCount', 'sampleMeanBytes', 'sampleUpperBytes', 'sampleUpperBitsPerSecond']) : null,
      library: source ? {
        indexedCount: finite(source.library?.indexedCount),
        folders: folders.map(function (entry, index) { return { folder: index + 1, indexedItems: finite(entry.count) }; })
      } : null,
      recommendations: report.advice,
      unavailable: report.unavailable
    };
  }

  function node(tag, className, label) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (label !== undefined) element.textContent = label;
    return element;
  }

  function control(label) {
    var button = node('button', 'dashboard-next', label);
    button.type = 'button';
    return button;
  }

  async function request(url, options, signal) {
    var response = await fetch(url, { ...options, cache: 'no-store', signal });
    if (!response.ok) {
      if (response.status === 409) throw Error('The host is busy. Try again after the scan or other benchmark finishes.');
      if (response.status === 401 || response.status === 403) throw Error('Sign in as the owner to run this test.');
      if (response.status === 429) throw Error('Another benchmark is using the connection test. Try again shortly.');
      throw Error('The server could not complete this test.');
    }
    return response;
  }

  async function measureConnection(signal) {
    var latencies = [];
    for (var i = 0; i < 3; i++) {
      var pingStart = performance.now();
      await request('/api/benchmark/network?probe=1', {}, signal);
      latencies.push(performance.now() - pingStart);
    }
    var start = performance.now();
    var response = await request('/api/benchmark/network', {}, signal);
    var headers = performance.now();
    var reader = response.body.getReader();
    var bytes = 0;
    try {
      for (;;) {
        var read = await reader.read();
        if (read.done) break;
        bytes += read.value.byteLength;
        if (bytes > MAX_DOWNLOAD) throw Error('The test response exceeded its size limit.');
      }
    } catch (error) {
      await reader.cancel().catch(function () {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (bytes !== MAX_DOWNLOAD) throw Error('The test download ended early.');
    var elapsed = Math.max(0.1, performance.now() - start);
    latencies.sort(function (a, b) { return a - b; });
    return {
      downloadBytes: bytes,
      elapsedMs: rounded(elapsed, 2),
      headersMs: rounded(headers - start, 2),
      medianLatencyMs: rounded(latencies[1], 2),
      downloadMbps: rounded(bytes * 8 / (elapsed * 1000), 2)
    };
  }

  function samplePlayback(videos, signal) {
    var tracks = videos.filter(function (video) { return !video.paused && typeof video.getVideoPlaybackQuality === 'function'; });
    if (document.hidden || signal.aborted || !tracks.length) return Promise.resolve(null);
    var initial = tracks.map(function (video) { return video.getVideoPlaybackQuality(); });
    return new Promise(function (resolve) {
      function cancel() {
        clearTimeout(timer);
        resolve(null);
      }
      var timer = setTimeout(function () {
        var total = 0;
        var dropped = 0;
        tracks.forEach(function (video, index) {
          var now = video.getVideoPlaybackQuality();
          total += Math.max(0, now.totalVideoFrames - initial[index].totalVideoFrames);
          dropped += Math.max(0, now.droppedVideoFrames - initial[index].droppedVideoFrames);
        });
        signal.removeEventListener('abort', cancel);
        resolve(!document.hidden && total >= 12 ? {
          sampledVideos: tracks.length, durationMs: 900,
          totalFrames: total, droppedFrames: dropped, droppedPercent: rounded(100 * dropped / total, 1)
        } : null);
      }, 900);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  function metricCard(grid, title, rows) {
    var card = node('section', 'benchmark-card');
    var list = node('dl');
    card.appendChild(node('h4', null, title));
    rows.forEach(function (row) { list.append(node('dt', null, row[0]), node('dd', 'mono', row[1])); });
    card.appendChild(list);
    grid.appendChild(card);
  }

  function adviceText(result, line) {
    var advice = result.advice;
    var fragments = [];
    if (advice.pauseAutoplay) fragments.push('Pause autoplay or use Data saver on this connection. If you enable autoplay, start with four optimized previews.');
    else if (advice.concurrentOptimizedPreviews !== null) fragments.push('Start with ' + advice.concurrentOptimizedPreviews + ' concurrent previews and set Preview source to Optimized in View.');
    else fragments.push('Start with four optimized previews and increase the limit after a connection test.');
    fragments.push('This estimate plans for ' + displayNumber(advice.assumedPreviewMbps, ' Mbps per preview') + ' and reserves half the measured download speed.');
    if (result.host?.cache?.storage === 'ram') {
      fragments.push('This installation uses a RAM cache. Size the runtime cache within the container memory limit and leave disk space for snapshot generations.');
    }
    if (advice.cacheAdditionalBudgetBytes !== null) {
      fragments.push('Plan up to ' + size(advice.cacheAdditionalBudgetBytes) + ' of additional cache and keep ' + size(advice.suggestedDiskHeadroomBytes) + ' free.');
    }
    fragments.forEach(function (text) { line.appendChild(node('p', null, text)); });
    if (advice.folderShares.length) {
      var list = node('ul', 'benchmark-folder-list');
      advice.folderShares.forEach(function (share, index) {
        var row = node('li');
        row.append(node('span', null, result.host.library.folders[index].name || 'Folder ' + share.folder), node('strong', 'mono', size(share.additionalBytes)));
        list.appendChild(row);
      });
      line.append(node('h5', null, 'Planning allowance per folder'), list, node('p', 'modal-sub', 'Use these shares to prioritize cache growth. The app keeps its existing global storage settings.'));
    }
    if (result.host?.cache?.boundedBytes > 0) {
      line.appendChild(node('p', 'modal-sub', 'Your existing ' + size(result.host.cache.boundedBytes) + ' preview cache limit still applies.'));
    }
  }

  function draw(target, result) {
    target.replaceChildren();
    var source = result.host;
    var resources = source?.host;
    var cache = source?.cache;
    var connection = result.connection;
    var grid = node('div', 'benchmark-grid');
    var cpuRate = source?.cpu?.elapsedMs > 0 && finite(source.cpu.iterations) !== null ? 1000 * source.cpu.iterations / source.cpu.elapsedMs : null;
    metricCard(grid, 'Host resources', [
      ['Processor', resources?.cpuModel || 'Unavailable'],
      ['CPU available', displayNumber(resources?.effectiveCores, ' logical CPUs')],
      ['Memory available', size(resources?.effectiveMemoryBytes)],
      ['CPU sample', displayNumber(cpuRate, ' iterations/s')]
    ]);
    metricCard(grid, 'Browser connection', [
      ['Download', displayNumber(connection?.downloadMbps, ' Mbps')],
      ['Median request time', displayNumber(connection?.medianLatencyMs, ' ms')],
      ['Dropped preview frames', result.playback ? displayNumber(result.playback.droppedPercent, '%') : 'No active sample']
    ]);
    metricCard(grid, 'Cache storage', [
      ['Free space on backing storage', size(cache?.freeBytes)],
      ...(cache?.storage === 'ram' ? [['Free space in RAM cache', size(cache.runtimeFreeBytes)]] : []),
      ['Test write', displayNumber(cache?.writeMiBps, ' MiB/s')],
      ['Warm test read', displayNumber(cache?.warmReadMiBps, ' MiB/s')]
    ]);
    target.appendChild(grid);
    var notes = node('div', 'benchmark-recommendations');
    notes.appendChild(node('h4', null, 'Suggested settings'));
    adviceText(result, notes);
    target.appendChild(notes);
    if (result.unavailable.length || source?.warnings?.length) {
      var warnings = node('ul', 'benchmark-warnings');
      [...result.unavailable.map(function (name) { return name + ' test unavailable.'; }), ...(source?.warnings || [])].forEach(function (warning) {
        warnings.appendChild(node('li', null, warning));
      });
      target.appendChild(warnings);
    }
    target.appendChild(node('p', 'modal-sub', 'The network result covers this browser’s connection to VidStream. Disk results are a short cache-volume sample, and the warm read can include memory caching.'));
  }

  function mount(parent, options = {}) {
    var section = node('section', 'dashboard-section dashboard-benchmark');
    var run = control('Run benchmark');
    var cancel = control('Cancel');
    var download = control('Download JSON');
    var status = node('p', 'benchmark-status');
    status.setAttribute('role', 'status');
    var results = node('div', 'benchmark-results');
    var actions = node('div', 'benchmark-actions');
    actions.append(run, cancel, download);
    section.append(node('h3', null, 'Benchmark'), node('p', 'modal-sub', 'Measure this browser’s connection, the server’s resources and cache storage. Uses a 4 MiB network download and temporary cache writes.'), actions, status, results);
    parent.appendChild(section);
    var controller;
    var activeReport = recentReport;
    cancel.hidden = true;
    download.hidden = !activeReport;
    if (activeReport) {
      draw(results, activeReport);
      status.textContent = activeReport.unavailable.length ? 'Benchmark complete with unavailable results.' : 'Benchmark complete.';
    }
    cancel.onclick = function () { controller?.abort(); };
    download.onclick = function () {
      if (!activeReport) return;
      var report = sanitize(activeReport);
      var objectUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      var link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'vidstream-benchmark-' + report.measuredAt.slice(0, 10) + '.json';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
    };
    run.onclick = async function () {
      run.disabled = true;
      cancel.hidden = false;
      download.hidden = true;
      results.replaceChildren();
      var current = controller = new AbortController();
      var timedOut = false;
      var deadline = setTimeout(function () { timedOut = true; current.abort(); }, 30000);
      var report = {
        measuredAt: new Date().toISOString(), applicationVersion: options.version || null, connection: null,
        host: null, playback: null, unavailable: []
      };
      var lastError;
      try {
        status.textContent = 'Measuring browser connection…';
        try { report.connection = await measureConnection(current.signal); }
        catch (error) { report.unavailable.push('Browser connection'); lastError = error; }
        if (!current.signal.aborted) {
          status.textContent = 'Measuring host and cache storage…';
          try {
            var response = await request('/api/benchmark/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, current.signal);
            report.host = await response.json();
          } catch (error) { report.unavailable.push('Host'); lastError = error; }
        }
        if (!current.signal.aborted) report.playback = await samplePlayback(options.videos?.() || [], current.signal);
        if (!section.isConnected) return;
        if (current.signal.aborted) {
          status.textContent = timedOut ? 'The benchmark timed out. Try again when the server is less busy.' : 'Benchmark canceled.';
          return;
        }
        if (!report.host && !report.connection) throw lastError || Error('Benchmark unavailable.');
        report.advice = suggestions(report.host, report.connection, report.playback);
        activeReport = recentReport = report;
        draw(results, report);
        status.textContent = report.unavailable.length ? 'Benchmark complete with unavailable results.' : 'Benchmark complete.';
      } catch (error) {
        status.textContent = error.message || 'Benchmark unavailable.';
      } finally {
        clearTimeout(deadline);
        controller = undefined;
        run.disabled = false;
        cancel.hidden = true;
        download.hidden = !activeReport;
        if (activeReport && !results.children.length && section.isConnected) draw(results, activeReport);
      }
    };
    return { dispose: function () { controller?.abort(); } };
  }

  return { mount, suggestions, sanitize };
});
