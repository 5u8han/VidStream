(function () {
  'use strict';

  var unread = 0, summaryRequest;
  var names = {
    MEDIA_REPAIR_REQUESTED: 'Manual media repair',
    SCAN_UNSUPPORTED_FORMAT: 'Unsupported file',
    SCAN_FILE_FAILED: 'Media could not be imported',
    SCAN_DIRECTORY_UNREADABLE: 'Directory could not be read',
    SCAN_INTERVAL_FAILED: 'Scheduled scan failed',
    SOURCE_CACHE_UNAVAILABLE: 'Source cache unavailable',
    DERIVATIVE_CACHE_WARNING: 'Preview cache warning',
    REQUEST_FAILED: 'Server request failed',
    NODE_UNREACHABLE: 'Library node is offline',
    NODE_IDENTITY_CHANGED: 'Library node identity changed',
    SCAN_TASK_WAITING: 'Scan task is taking longer than expected',
    SCAN_WAITING: 'Scan is waiting',
    BACKGROUND_TASK_WAITING: 'Background task is taking longer than expected',
    BACKGROUND_TASK_FAILED: 'Background task failed',
    BACKGROUND_TASK_INTERRUPTED: 'Background task interrupted',
    LOW_DISK_SPACE: 'Disk space is low',
    DISK_STATUS_UNAVAILABLE: 'Storage status unavailable',
  };

  function node(tag, text, parent, className) {
    var element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    if (parent) parent.appendChild(element);
    return element;
  }

  function setCount(value) {
    unread = Number(value) || 0;
    document.querySelectorAll('[data-issue-count]').forEach(function (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.setAttribute('aria-label', unread + ' unread notifications');
    });
  }

  async function request(query, signal) {
    var response = await fetch('/api/notifications?' + query, { signal: signal });
    if (!response.ok) throw Error('Notifications could not load.');
    var data = await response.json();
    if (!data.id && data.unread !== undefined) setCount(data.unread);
    return data;
  }

  function poll() {
    if (document.hidden || summaryRequest) return;
    summaryRequest = request('view=summary').catch(function () {}).finally(function () { summaryRequest = null; });
  }

  function repairAction(id, parent, initial, kind, onUpdate, compact) {
    var label = kind === 'playback' ? 'Retry playback copy' : 'Repair now';
    var button = node('button', label, parent, 'dashboard-next');
    button.type = 'button';
    var status = node('span', '', parent, 'modal-sub');
    status.setAttribute('role', 'status');
    var link = node('a', 'Open playback copy', parent, 'dashboard-next');
    link.target = '_blank';
    link.rel = 'noopener';
    var pathname = '/api/notifications/' + encodeURIComponent(id) + '/repair';

    function show(result) {
      button.dataset.state = result?.state || 'idle';
      button.disabled = result?.state === 'running' || result?.state === 'queued';
      button.textContent = result?.state === 'queued' ? 'Queued' : button.disabled ? 'Working…' : result?.state === 'completed' ? 'Repair again' : label;
      status.textContent = result?.message || '';
      status.hidden = compact && result?.state !== 'failed' && Boolean(result?.state);
      link.hidden = !result?.playbackUrl;
      if (result?.playbackUrl) link.href = result.playbackUrl;
      else link.removeAttribute('href');
      onUpdate?.(result);
    }

    async function check() {
      while (button.isConnected && button.disabled) {
        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
        if (!button.isConnected || button.closest('[hidden]')) return;
        if (document.hidden) continue;
        try {
          var response = await fetch(pathname);
          if (!response.ok) throw Error('Could not check repair status.');
          show(await response.json());
        } catch (error) {
          status.hidden = false;
          status.textContent = error.message;
          if (button.disabled) await new Promise(function (resolve) { setTimeout(resolve, 4000); });
        }
      }
    }

    button.onclick = async function () {
      show({ state: 'running', message: 'Starting repair…' });
      try {
        var response = await fetch(pathname, { method: 'POST' });
        var result = await response.json();
        if (!response.ok) throw Error(result.error || 'Could not start repair.');
        show(result);
        void check();
      } catch (error) {
        show({ message: error.message });
      }
    };
    show(initial);
    if (button.disabled) void check();
  }

  function issueTitle(issue) {
    if (issue.code === 'MEDIA_REPAIR_REQUESTED' && issue.stage === 'playback') return 'Playback copy requested';
    if (issue.code === 'BACKGROUND_TASK_FAILED' && issue.stage === 'playback') return 'Playback copy failed';
    return names[issue.code] || issue.code.toLowerCase().split('_').join(' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function issueRow(issue, parent, tag, onOpen, message) {
    var row = node(tag, undefined, parent, 'dashboard-notification');
    row.dataset.level = issue.level;
    if (issue.unread && tag === 'li') row.dataset.unread = '';
    var top = node('div', undefined, row, 'dashboard-notification-title');
    node('strong', issueTitle(issue), top);
    var time = node('time', new Date(issue.lastAt).toLocaleString(), top, 'mono');
    time.dateTime = new Date(issue.lastAt).toISOString();
    node('p', issue.message, row);
    var meta = node('div', undefined, row, 'dashboard-notification-meta');
    node('code', issue.id + (issue.occurrences > 1 ? ' · ' + issue.occurrences + ' occurrences' : ''), meta);
    if (issue.stage) node('span', issue.stage, meta);
    if (!issue.path) return row;
    var filepath = node('code', issue.path, row, 'dashboard-issue-path');
    filepath.title = 'Path relative to the media mount';
    var actions = node('div', undefined, row, 'dashboard-notification-actions');
    if (issue.itemId) {
      var open = node('button', 'Open media', actions, 'dashboard-next');
      open.type = 'button';
      open.onclick = function () { onOpen(issue.itemId); };
    }
    var copy = node('button', 'Copy path', actions, 'dashboard-next');
    copy.type = 'button';
    copy.onclick = async function () {
      if (navigator.clipboard) {
        try { await navigator.clipboard.writeText(issue.path); message.textContent = 'Path copied.'; return; } catch (_) {}
      }
      var selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(filepath);
      selection.removeAllRanges(); selection.addRange(range);
      message.textContent = 'Path selected. Use your usual copy shortcut.';
    };
    return actions;
  }

  function mount(parent, callbacks) {
    var pane = node('section', undefined, parent, 'dashboard-body dashboard-notifications');
    pane.id = 'dashboard-notifications';
    pane.setAttribute('aria-label', 'Notifications');
    pane.hidden = true;
    var toolbar = node('div', undefined, pane, 'dashboard-notification-tools');
    var category = node('select', undefined, toolbar, 'filter-select');
    category.setAttribute('aria-label', 'Notification category');
    [['operations','Operations'], ['all','All categories'], ['media','Media'], ['scanning','Scanning'], ['storage','Storage'],
      ['nodes','Nodes'], ['system','System']].forEach(function (option) { category.add(new Option(option[1], option[0])); });
    var errors = node('button', 'Errors only', toolbar, 'dashboard-next');
    errors.type = 'button';
    errors.setAttribute('aria-pressed', 'false');
    var mark = node('button', 'Mark category read', toolbar, 'dashboard-next');
    mark.type = 'button';
    var message = node('p', '', pane, 'modal-sub');
    message.setAttribute('role', 'status');
    var list = node('ul', undefined, pane, 'dashboard-notification-list');
    var more = node('button', 'Load older', pane, 'dashboard-next');
    more.type = 'button';
    more.hidden = true;
    var offset = 0, seq = 0, interval, errorsOnly = false;

    async function load(append) {
      var id = ++seq;
      more.disabled = true;
      try {
        var data = await request(filters() + '&offset=' + (append ? offset : 0));
        if (id !== seq || pane.hidden) return;
        if (!append) list.replaceChildren();
        data.issues.forEach(function (issue) {
          var actions = issueRow(issue, list, 'li', callbacks.openItem, message);
          if (issue.repairable) {
            var repair = node('button', 'Manage repair', actions, 'dashboard-next');
            repair.type = 'button';
            repair.onclick = function () { callbacks.openRepair(issue.id, repair); };
          }
        });
        offset = data.nextOffset;
        more.hidden = offset === null;
        mark.disabled = !data.unread || !list.children.length;
        message.textContent = data.storageError ? 'Some notifications could not be saved.' : list.children.length ? '' : 'No notifications match these filters.';
      } catch (error) {
        if (id === seq) message.textContent = error.message;
      } finally {
        if (id === seq) more.disabled = false;
      }
    }

    function close() {
      seq++;
      clearInterval(interval);
      pane.hidden = true;
    }

    function show() {
      if (!pane.hidden) return;
      pane.hidden = false;

      message.textContent = 'Loading notifications…';
      load(false);
      interval = setInterval(function () {
        if (!pane.hidden && !document.hidden && !pane.contains(document.activeElement) && pane.scrollTop < 10) load(false);
      }, 5000);
    }

    function filters() { return 'category=' + encodeURIComponent(category.value) + (errorsOnly ? '&level=error' : ''); }
    category.onchange = function () { void load(false); };
    errors.onclick = function () {
      errorsOnly = !errorsOnly;
      errors.setAttribute('aria-pressed', String(errorsOnly));
      load(false);
    };
    more.onclick = function () { load(true); };
    mark.onclick = async function () {
      mark.disabled = true;
      try {
        var response = await fetch('/api/notifications/read?' + filters(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!response.ok) throw Error('Could not mark notifications read.');
        await load(false);
      } catch (error) { message.textContent = error.message; mark.disabled = false; }
    };
    setCount(unread);
    return { open: show, close: close, isOpen: function () { return !pane.hidden; } };
  }

  function mountRepairs(parent, callbacks) {
    var root = node('div', undefined, parent, 'dashboard-body dashboard-repairs');
    root.hidden = true;
    var overview = node('section', undefined, root);
    var heading = node('h3', 'Media repairs', overview);
    heading.tabIndex = -1;
    var form = node('form', undefined, overview, 'dashboard-repair-form');
    var label = node('label', 'Repair a file by library path', form);
    var pathInput = node('input', undefined, label);
    pathInput.required = true;
    pathInput.placeholder = 'Family/Trips/clip.mp4';
    pathInput.maxLength = 4096;
    var kind = node('select', undefined, form, 'filter-select');
    kind.setAttribute('aria-label', 'Repair type');
    kind.add(new Option('Preview and catalog entry', 'scan'));
    kind.add(new Option('Compatible video copy', 'playback'));
    var start = node('button', 'Repair now', form, 'dashboard-next');
    start.type = 'submit';
    node('p', 'Choose a preview rebuild for photos or videos, or a compatible playback copy for an indexed video. Indexing can keep running.', overview, 'modal-sub');
    var toolbar = node('div', undefined, overview, 'dashboard-repair-tools');
    var refresh = node('button', 'Refresh list', toolbar, 'dashboard-next');
    refresh.type = 'button';
    var recovery = node('a', 'Export recovery list', toolbar, 'dashboard-next');
    recovery.href = '/api/notifications/recovery';
    recovery.download = 'vidstream-recovery.json';
    recovery.hidden = true;
    var message = node('p', '', overview, 'modal-sub');
    message.setAttribute('role', 'status');
    var list = node('ul', undefined, overview, 'dashboard-notification-list');
    var more = node('button', 'Load older media issues', overview, 'dashboard-next');
    more.type = 'button';
    more.hidden = true;
    var detail = node('section', undefined, root);
    detail.hidden = true;
    var nextOffset = null, listScroll = 0, listRequest, detailRequest, visible = new Map();

    form.onsubmit = async function (event) {
      event.preventDefault();
      start.disabled = true;
      try {
        var response = await fetch('/api/notifications/repair-path', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pathInput.value, kind: kind.value }) });
        var result = await response.json();
        if (!response.ok) throw Error(result.error || 'Could not start repair.');
        if (!root.hidden && !overview.hidden) {
          void load(false);
          callbacks.openRepair(result.id, start);
        }
      } catch (error) { message.textContent = error.message; }
      finally { start.disabled = false; }
    };

    function paintStatus(row, result) {
      var state = result?.state;
      row.dataset.state = state || 'idle';
      row.textContent = { queued: 'Queued', running: 'Repairing', completed: 'Repaired', failed: 'Needs review', interrupted: 'Interrupted' }[state] || 'Ready to review';
    }

    async function load(append) {
      listRequest?.abort();
      var requestRef = listRequest = new AbortController();
      refresh.disabled = more.disabled = true;
      if (!append) message.textContent = 'Loading media issues…';
      try {
        var data = await request('view=repairs&offset=' + (append ? nextOffset : 0), requestRef.signal);
        if (requestRef !== listRequest) return;
        if (!append) { list.replaceChildren(); visible.clear(); }
        data.issues.forEach(function (issue) {
          if (visible.has(issue.id)) return;
          var row = node('li', undefined, list, 'dashboard-repair-entry');
          var button = node('button', undefined, row, 'dashboard-repair-row');
          button.type = 'button';
          var contents = node('span', undefined, button);
          node('strong', issue.path, contents);
          node('small', issueTitle(issue) + ' · ' + new Date(issue.lastAt).toLocaleString(), contents);
          var status = node('span', undefined, button, 'dashboard-repair-state');
          paintStatus(status, issue.repair);
          visible.set(issue.id, status);
          if (issue.repairable) {
            var quick = node('div', undefined, row, 'dashboard-repair-quick');
            repairAction(issue.id, quick, issue.repair, issue.repairKind, function (update) {
              if (update?.state) paintStatus(status, update);
            }, true);
          }
          button.onclick = function () { callbacks.openRepair(issue.id, button); };
        });
        nextOffset = data.nextOffset;
        more.hidden = nextOffset === null;
        recovery.hidden = !data.canExportRecovery;
        message.textContent = data.storageError ? 'Some diagnostics could not be saved.' :
          list.children.length ? '' : 'No failed imports or playback copies recorded.';
      } catch (error) {
        if (error.name !== 'AbortError' && requestRef === listRequest) message.textContent = error.message;
      } finally {
        if (requestRef === listRequest) refresh.disabled = more.disabled = false;
      }
    }

    function showList(focus) {
      detailRequest?.abort();
      detailRequest = null;
      detail.replaceChildren();
      detail.hidden = true;
      overview.hidden = false;
      root.scrollTop = listScroll;
      (focus?.isConnected ? focus : heading).focus({ preventScroll: true });
    }

    async function showDetail(id) {
      if (!overview.hidden) listScroll = root.scrollTop;
      overview.hidden = true;
      detail.hidden = false;
      detail.replaceChildren();
      detailRequest?.abort();
      var requestRef = detailRequest = new AbortController();
      var title = node('h3', 'Repair details', detail);
      title.tabIndex = -1;
      var result = node('p', 'Loading media issue…', detail, 'modal-sub');
      result.setAttribute('role', 'status');
      root.scrollTop = 0;
      title.focus({ preventScroll: true });
      try {
        var issue = await request('view=repairs&id=' + encodeURIComponent(id), requestRef.signal);
        if (requestRef !== detailRequest) return;
        result.textContent = '';
        var actions = issueRow(issue, detail, 'div', callbacks.openItem, result);
        if (issue.repairable) {
          var state = node('span', undefined, actions, 'dashboard-repair-state');
          paintStatus(state, issue.repair);
          repairAction(issue.id, actions, issue.repair, issue.repairKind, function (update) {
            if (!update?.state) return;
            paintStatus(state, update);
            var row = visible.get(id);
            if (row) paintStatus(row, update);
          });
        }
        else result.textContent = 'This media is no longer available for repair.';
      } catch (error) {
        if (error.name !== 'AbortError' && requestRef === detailRequest) result.textContent = 'The media issue could not be loaded.';
      }
    }

    refresh.onclick = function () { void load(false); };
    more.onclick = function () { void load(true); };
    return {
      open: function () { root.hidden = false; listScroll = 0; showList(); void load(false); },
      showList: function (origin) { showList(origin); void load(false); },
      showDetail: showDetail,
      close: function () {
        listRequest?.abort();
        detailRequest?.abort();
        listRequest = detailRequest = null;
        detail.replaceChildren();
        list.replaceChildren(); visible.clear();
        root.hidden = true;
      },
    };
  }

  window.StreamDashboardNotifications = { mount: mount, mountRepairs: mountRepairs, poll: poll };
})();
