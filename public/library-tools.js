(function () {
  'use strict';
  function node(tag, text, parent) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  async function api(url, body) {
    var r = await fetch(
      url,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }
    );
    var j = await r.json();
    if (!r.ok) throw Error(j.error || 'Request failed');
    return j;
  }
  function button(label, parent, action) {
    var b = node('button', label, parent);
    b.type = 'button';
    b.onclick = async function () {
      b.disabled = true;
      try {
        await action();
      } catch (e) {
        var error = parent.querySelector('.workbench-error') || node('p', '', parent);
        error.className = 'workbench-error';
        error.textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  function select(label, values, parent) {
    var wrap = node('label', label, parent),
      s = node('select', undefined, wrap);
    s.setAttribute('aria-label', label);
    values.forEach(function (v) {
      var o = node('option', v[1], s);
      o.value = v[0];
    });
    return s;
  }
  function check(label, parent) {
    var wrap = node('label', label + ' ', parent),
      c = node('input', undefined, wrap);
    c.type = 'checkbox';
    return c;
  }
  function amount(n) {
    if (!Number.isFinite(n)) return 'Unavailable';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'],
      i = 0;
    while (n >= 1000 && i < units.length - 1) {
      n /= 1000;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
  }
  function maintenance(pane) {
    node(
      'p',
      'Inspect work and storage, create a consistent catalog snapshot, or manage raw activity retention. Media and configuration are separate from the catalog backup.',
      pane
    );
    node('h3', 'Background work', pane);
    var preset = select(
        'Background work',
        [
          ['browse', 'Browse comfortably'],
          ['balanced', 'Balanced'],
          ['process', 'Process faster']
        ],
        pane
      ),
      status = node('pre', 'Select Refresh status to inspect current work.', pane);
    preset.onchange = function () {
      api('/api/work/preset', { preset: preset.value })
        .then(refresh)
        .catch(function (e) {
          status.textContent = e.message;
        });
    };
    async function refresh() {
      var r = await api('/api/work');
      preset.value = r.work.preset;
      status.textContent =
        r.work.active
          .map(function (t) {
            return t.kind + ': ' + t.label;
          })
          .join('\n') || 'No background work running.';
      status.textContent += '\n' + r.work.queued.length + ' queued · ' + r.work.note;
      var failed = r.work.recent
        .filter(function (t) {
          return t.state === 'failed' || t.state === 'interrupted';
        })
        .slice(0, 5);
      failed.forEach(function (t) {
        status.textContent += '\n' + t.label + ': ' + t.error;
      });
    }
    button('Refresh status', pane, refresh);
    button('Retry / reconcile library', pane, async function () {
      await api('/api/rescan', {});
      await refresh();
    });
    node('h3', 'Storage and backups', pane);
    var storage = node('pre', '', pane);
    button('Measure storage', pane, async function () {
      var r = await api('/api/maintenance/storage');
      storage.textContent = [
        'Original media: ' + amount(r.originalMediaBytes),
        'Preview cache: ' + amount(r.cacheBytes),
        'Application data: ' + amount(r.dataBytes),
        'Original archive: ' + amount(r.archiveBytes),
        'Free on data disk: ' + amount(r.freeBytes),
        r.note,
        'Folders: ' + JSON.stringify(r.paths, null, 2)
      ].join('\n');
    });
    button('Create catalog backup', pane, async function () {
      var r = await api('/api/maintenance/backup', {});
      var link = node('a', 'Download consistent catalog snapshot', pane);
      link.href = r.url;
      link.download = r.name;
      node('p', r.note, pane);
    });
    node('h3', 'Relink or label media', pane);
    node(
      'p',
      'Copy the permanent media ID from the player Info panel. Relinking preserves its history, requires identical bytes, and refuses paths already owned by another item. Artist labels apply to the selected item and do not rename folders.',
      pane
    );
    var idLabel = node('label', 'Permanent media ID or link ID ', pane),
      mediaId = node('input', undefined, idLabel);
    mediaId.type = 'text';
    mediaId.setAttribute('aria-label', 'Media to manage');
    var pathLabel = node('label', 'New path relative to the media folder ', pane),
      relativePath = node('input', undefined, pathLabel);
    relativePath.type = 'text';
    relativePath.placeholder = 'Artist/video.mp4';
    button('Relink moved media', pane, async function () {
      var r = await api('/api/items/' + encodeURIComponent(mediaId.value.trim()) + '/relink', {
        path: relativePath.value.trim()
      });
      status.textContent = 'Relinked ' + r.item.filename + '; identity and history retained.';
    });
    var aliasLabel = node('label', 'Artist display label (empty restores folder label) ', pane),
      alias = node('input', undefined, aliasLabel);
    alias.type = 'text';
    alias.maxLength = 120;
    button('Save artist label', pane, async function () {
      await api('/api/items/' + encodeURIComponent(mediaId.value.trim()) + '/preferences', {
        creatorAlias: alias.value
      });
      status.textContent = 'Artist label saved. Refresh the gallery to see the new label.';
    });
    node('h3', 'Move to another machine', pane);
    node(
      'p',
      'Stop the old server before copying its complete data folder, media and original archives. Cache can be copied or rebuilt. Keep SQLite on local storage, configure the same media mapping on the destination, then start only the replacement instance. A catalog backup contains records, not your media files. New independent libraries need their own fresh data and sign-in.',
      pane
    );
    node('h3', 'Activity retention', pane);
    var label = node('label', 'Retain raw activity for this many days: ', pane),
      days = node('input', undefined, label);
    days.type = 'number';
    days.min = '7';
    days.max = '3650';
    days.value = '90';
    var consent = check(
      'Remove older raw events, keeping cumulative counts and viewing positions',
      pane
    );
    button('Apply raw-event retention', pane, async function () {
      if (!consent.checked) throw Error('Check the event-removal confirmation first');
      var r = await api('/api/maintenance/retention', { days: Number(days.value), confirm: true });
      status.textContent = r.removed + ' old raw events removed. ' + r.note;
    });
  }
  async function preparePlayback(video, item) {
    if (video._preparingPlayback) return;
    video._preparingPlayback = true;
    var message = document.createElement('p');
    message.className = 'playback-preparation';
    message.textContent = 'Preparing a compatible playback copy…';
    video.parentElement.appendChild(message);
    try {
      for (var attempt = 0; attempt < 180; attempt++) {
        if (!video.isConnected) return;
        var r = await api('/api/items/' + item.id + '/playback', {});
        if (r.state === 'failed') throw Error(r.error);
        if (r.state === 'completed') {
          video.dataset.sourceKind = 'compatible';
          video.src = r.url;
          await video.play();
          message.remove();
          return;
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 1000);
        });
      }
      throw Error('Preparation is still running; reopen the video after checking Maintenance.');
    } catch (e) {
      message.textContent = e.message;
    } finally {
      video._preparingPlayback = false;
    }
  }
  window.StreamLibraryTools = {
    maintenance: maintenance,
    preparePlayback: preparePlayback
  };
})();
