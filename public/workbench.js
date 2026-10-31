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
  function comparison(parent, item, job) {
    var previous = parent.closest('dialog')?.querySelector('.enhancement-comparison');
    previous?._release?.();
    previous?.remove();
    var box = node('section', undefined, parent);
    box.className = 'enhancement-comparison';
    node('p', 'Original / result · synchronized comparison. Original audio is used.', box);
    var row = node('div', undefined, box);
    row.className = 'comparison-videos';
    var original = node('video', undefined, row),
      result = node('video', undefined, row);
    original.src = item.urls.original || item.urls.full;
    result.src = job.url;
    original.controls = true;
    result.controls = false;
    result.muted = true;
    original.playsInline = result.playsInline = true;
    var offset = job.options.start || 0,
      end = offset + job.duration;
    function sync() {
      var position = Math.max(0, original.currentTime - offset);
      if (Math.abs(result.currentTime - position) > 0.15) result.currentTime = position;
      if (job.options.preview && original.currentTime >= end) {
        original.pause();
        result.pause();
      }
    }
    original.addEventListener('loadedmetadata', function () {
      original.currentTime = offset;
    });
    original.addEventListener('play', function () {
      if (original.currentTime < offset || (job.options.preview && original.currentTime >= end))
        original.currentTime = offset;
      sync();
      result.play().catch(function () {});
    });
    original.addEventListener('pause', function () {
      result.pause();
    });
    original.addEventListener('timeupdate', sync);
    original.addEventListener('seeked', sync);
    var dialog = parent.closest('dialog');
    box._release = function () {
      [original, result].forEach(function (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
      dialog?.removeEventListener('close', closed);
    };
    function closed() {
      box._release();
      box.remove();
    }
    dialog?.addEventListener('close', closed, { once: true });
  }
  async function enhance(body, item, video, close) {
    node('p', item.filename, body);
    node(
      'p',
      'Try a short sample, compare it with the original, then queue a full version. Processing continues on the server.',
      body
    );
    var smoothing = select(
      'Smoothing',
      [
        ['ffmpeg', '60 fps · optical flow'],
        ['rife-v4.6', '60 fps · RIFE'],
        ['none', 'Original frame rate']
      ],
      body
    );
    var upscale = select(
      'Upscaling',
      [
        ['none', 'Original resolution'],
        ['realesrgan-x4plus', 'Realistic 4×'],
        ['realesr-animevideov3', 'Animation 2×']
      ],
      body
    );
    try {
      var saved = JSON.parse(localStorage.getItem('stream-enhancement-recipe') || 'null');
      if (saved) {
        smoothing.value = saved.smoothing;
        upscale.value = saved.upscale;
      }
    } catch (_) {}
    var range = node('label', 'Sample start (seconds) ', body),
      start = node('input', undefined, range);
    start.type = 'number';
    start.min = '0';
    start.max = String(item.duration);
    start.step = '.1';
    start.value = '0';
    var estimate = node(
      'p',
      'Output: SDR H.264, 8-bit, constant frame rate, AAC audio. Original stays available. HDR/high-bit-depth enhancement is currently refused rather than silently converted.',
      body
    );
    function recipe(preview) {
      var data = { smoothing: smoothing.value, upscale: upscale.value };
      if (preview) {
        data.preview = true;
        data.start = Number(start.value);
        data.end = Math.min(item.duration, data.start + 5);
      }
      return data;
    }
    button('Estimate full job', body, async function () {
      var e = await api('/api/items/' + item.id + '/enhance-estimate', recipe(false));
      estimate.textContent =
        amount(e.workingBytes) +
        ' estimated working space · ' +
        (e.estimatedSeconds
          ? Math.round(e.estimatedSeconds / 60) + ' minutes based on sample (approximate)'
          : 'Render a sample for a time estimate') +
        '. ' +
        e.note;
    });
    button('Save processing recipe', body, function () {
      localStorage.setItem('stream-enhancement-recipe', JSON.stringify(recipe(false)));
      estimate.textContent = 'Recipe saved on this browser.';
    });
    var list = node('div', undefined, body),
      notice = node('p', '', body);
    async function queue(preview) {
      await api('/api/items/' + item.id + '/enhance', recipe(preview));
      notice.textContent = 'Saved job queued.';
      await jobs();
    }
    button('Render 5-second sample', body, function () {
      return queue(true);
    });
    button('Queue full video', body, function () {
      return queue(false);
    });
    button('Play original', body, function () {
      video.dataset.sourceKind = 'original';
      delete video.dataset.sourceFps;
      video.src = item.urls.original || item.urls.full;
      video.play().catch(function () {});
      close();
    });
    var snapshot = '';
    async function jobs() {
      if (!body.isConnected || !body.closest('dialog')?.open) return;
      var data = await api('/api/enhancements?item=' + encodeURIComponent(item.id)),
        value = JSON.stringify(data);
      if (value === snapshot) return;
      snapshot = value;
      // Keep an open comparison stable while only unrelated job progress changes.
      var comparisonNode = list.querySelector('.enhancement-comparison');
      if (comparisonNode) comparisonNode.remove();
      list.replaceChildren();
      if (!data.jobs.length) node('p', 'No saved jobs yet.', list);
      data.jobs.forEach(function (j) {
        var card = node('article', undefined, list);
        node(
          'strong',
          (j.options.preview ? 'Sample' : 'Full version') +
            ' · ' +
            j.state +
            ' · ' +
            Math.round(j.progress * 100) +
            '%',
          card
        );
        node('p', j.phase + (j.error ? ' · ' + j.error : ''), card);
        if (j.state === 'completed') {
          button('Compare original / result', card, function () {
            comparison(card, item, j);
          });
          button('Play result', card, function () {
            video.dataset.sourceKind = 'enhanced';
            video.dataset.sourceFps = String(j.options.fps);
            video.src = j.url;
            video.play().catch(function () {});
            close();
          });
          var download = node('a', 'Download result', card);
          download.href = j.url + '?download=1';
          download.download = '';
          if (!j.options.preview) {
            button('Approve & use by default', card, async function () {
              var r = await api('/api/items/' + item.id + '/variants', {
                action: 'activate',
                id: j.id
              });
              Object.assign(item, r.item);
              notice.textContent =
                'Approved. This version will open by default; the source remains unchanged.';
            });
            var consent = check(
              'I want to publish this result and move the original to the configured originals archive',
              card
            );
            button('Publish & archive original', card, async function () {
              if (!consent.checked) throw Error('Check the publication confirmation first');
              var r = await api('/api/items/' + item.id + '/variants', {
                action: 'publish',
                id: j.id,
                confirm: true
              });
              Object.assign(item, r.item);
              notice.textContent = r.note;
            });
          }
          var cleanup = check(
            'Remove reproducible intermediate frames/segments; retain the final result and source snapshot',
            card
          );
          button('Clean completed checkpoints', card, async function () {
            if (!cleanup.checked) throw Error('Check the cleanup confirmation first');
            await api('/api/enhancements/' + j.id, { action: 'cleanup', confirm: true });
            notice.textContent =
              'Intermediate frames and segments removed. Final output and source snapshot retained.';
          });
        } else if (j.state !== 'cancelled') {
          button(j.state === 'paused' ? 'Resume' : 'Pause', card, async function () {
            await api('/api/enhancements/' + j.id, {
              action: j.state === 'paused' ? 'resume' : 'pause'
            });
            snapshot = '';
            await jobs();
          });
          button('Cancel processing', card, async function () {
            await api('/api/enhancements/' + j.id, { action: 'cancel' });
            snapshot = '';
            await jobs();
          });
        }
      });
      if (comparisonNode) list.appendChild(comparisonNode);
    }
    button('Use original by default', body, async function () {
      var r = await api('/api/items/' + item.id + '/variants', {
        action: 'activate',
        id: 'original'
      });
      Object.assign(item, r.item);
      notice.textContent = 'Original selected as default.';
    });
    var restore = check('Restore the last published original from its archive', body);
    button('Restore archived original', body, async function () {
      if (!restore.checked) throw Error('Check the restore confirmation first');
      var r = await api('/api/items/' + item.id + '/variants', {
        action: 'restore',
        confirm: true
      });
      Object.assign(item, r.item);
      notice.textContent = r.note;
    });
    await jobs();
    var timer,
      current = body.closest('dialog');
    function refresh() {
      jobs().catch(function (e) {
        notice.textContent = e.message;
      });
    }
    current._resumePolling = function () {
      clearInterval(timer);
      snapshot = '';
      refresh();
      timer = setInterval(refresh, 3000);
    };
    current.addEventListener('close', function () {
      clearInterval(timer);
    });
    current._resumePolling();
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
        'Models / tools: ' + amount(r.modelBytes),
        'Snapshots / checkpoints: ' + amount(r.enhancementWorkBytes),
        'Results: ' + amount(r.outputBytes),
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
    var recovery = check(
      'Recover interrupted publication by restoring its verified archived original',
      pane
    );
    button('Recover interrupted publication', pane, async function () {
      if (!recovery.checked) throw Error('Check the recovery confirmation first');
      var r = await api('/api/maintenance/recover', { confirm: true });
      status.textContent =
        r.recovered + ' recovered · ' + r.issues.length + ' need manual review. ' + r.note;
      r.issues.forEach(function (issue) {
        status.textContent += '\n' + issue.id + ': ' + issue.error;
      });
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
      'Stop the old server and let it finish shutting down before copying. Transfer the complete data folder, media, models, and originals archive to the new machine; cache is optional and can be rebuilt. Keep each folder separate, use local storage for SQLite, and configure their paths before starting. Install the processing tools for the new operating system rather than copying its old executable tools. Start only one processing instance, reconcile the library, then resume saved jobs. The catalog backup alone does not contain videos or model files.',
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
  window.StreamWorkbench = {
    enhance: enhance,
    maintenance: maintenance,
    preparePlayback: preparePlayback
  };
})();
