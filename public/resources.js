(function () {
  'use strict';

  function bytes(value) {
    if (value == null) return 'Unavailable';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
    return value.toFixed(i ? 1 : 0) + ' ' + units[i];
  }
  function percent(value) { return value == null ? 'Sampling…' : value.toFixed(1) + '%'; }
  function element(tag, parent, title) {
    var node = document.createElement(tag);
    if (title) node.textContent = title;
    parent.appendChild(node);
    return node;
  }

  function mount(parent, isOpen, isVisible) {
    var root = element('div', parent), timer, disposed = false;
    root.className = 'dashboard-resources';
    var grid = element('dl', root);
    var error = element('p', root);
    var details = element('details', root);
    element('summary', details, 'Counters and measurement scope');
    var notes = element('div', details);
    var metrics = [];

    function render(d) {
      var next = [
        ['Host CPU', percent(d.cpu.hostPercent), d.cpu.name],
        ['App CPU', percent(d.cpu.workloadPercent), d.cpu.workloadScope + ' · ' + d.cpu.availableCores + ' cores'],
        ['Host RAM', bytes(d.memory.hostUsedBytes) + ' / ' + bytes(d.memory.hostTotalBytes), d.memory.hostNote],
        ['App RAM', bytes(d.memory.workloadUsedBytes) + ' / ' + bytes(d.memory.workloadLimitBytes), d.memory.scope],
        ['Disk read', d.io ? bytes(d.io.readBytesPerSecond) + '/s' : 'Unavailable', d.io?.scope],
        ['Disk write', d.io ? bytes(d.io.writeBytesPerSecond) + '/s' : 'Unavailable', d.io?.scope],
        ['Network in', d.network ? bytes(d.network.receiveBytesPerSecond) + '/s' : 'Unavailable', d.network?.scope],
        ['Network out', d.network ? bytes(d.network.sendBytesPerSecond) + '/s' : 'Unavailable', d.network?.scope],
        ['Storage free', bytes(d.disk?.availableBytes), bytes(d.disk?.totalBytes) + ' total on data volume']
      ];
      d.gpu.forEach(function (gpu) {
        var detail = gpu.unifiedMemory ? 'Unified memory' : [gpu.powerWatts != null && gpu.powerWatts + ' W',
          gpu.temperatureC != null && gpu.temperatureC + ' °C'].filter(Boolean).join(' · ');
        next.push([gpu.name, gpu.utilizationPercent == null ? 'Unavailable' : percent(gpu.utilizationPercent), detail],
          [gpu.unifiedMemory ? 'GPU shared RAM' : 'VRAM', bytes(gpu.usedBytes) + (gpu.unifiedMemory ? '' : ' / ' + bytes(gpu.totalBytes)),
            gpu.memoryControllerPercent == null ? '' : percent(gpu.memoryControllerPercent) + ' memory controller load']);
      });
      if (!d.gpu.length) next.push(['GPU / VRAM', 'Unavailable', 'GPU telemetry is unavailable on this host.']);
      next.forEach(function (entry, i) {
        if (!metrics[i]) {
          var row = element('div', grid);
          metrics[i] = [row, element('dt', row), element('dd', row)];
        }
        var cells = metrics[i];
        cells[1].textContent = entry[0];
        cells[2].textContent = entry[1];
        cells[0].title = entry[2] || '';
      });
      while (metrics.length > next.length) metrics.pop()[0].remove();
      var lines = [d.scope + ' · sampled ' + new Date(d.at).toLocaleTimeString(),
        'Since ' + new Date(d.totals.since).toLocaleDateString() + ' · ' + bytes(d.totals.readBytes) + ' read · ' +
        bytes(d.totals.writtenBytes) + ' written · ' + bytes(d.totals.receivedBytes) + ' received · ' + bytes(d.totals.sentBytes) + ' sent'];
      if (d.io) lines.push('Disk counters · ' + bytes(d.io.readBytes) + ' read · ' + bytes(d.io.writtenBytes) + ' written');
      if (d.network) lines.push('Network counters · ' + bytes(d.network.receivedBytes) + ' received · ' + bytes(d.network.sentBytes) + ' sent');
      notes.replaceChildren();
      lines.concat(next.filter(function (entry) { return entry[2]; }).map(function (entry) { return entry[0] + ' · ' + entry[2]; }), d.notes || [])
        .forEach(function (line) { element('p', notes, line); });
    }
    var controller = new AbortController();
    async function update() {
      if (disposed || !isOpen() || !root.isConnected) return;
      if (!document.hidden && (!isVisible || isVisible())) {
        try {
          var response = await fetch('/api/resources', { signal: controller.signal });
          if (!response.ok) throw Error('Server measurements are unavailable.');
          var data = await response.json();
          if (disposed || !root.isConnected) return;
          render(data);
          error.textContent = '';
        } catch (reason) {
          if (!disposed) error.textContent = reason.message;
        }
      }
      if (!disposed) timer = setTimeout(update, 5000);
    }
    void update();
    return function () { disposed = true; clearTimeout(timer); controller.abort(); };
  }
  window.StreamResources = { mount: mount, bytes: bytes };
})();
