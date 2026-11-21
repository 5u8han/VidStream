(function () {
  'use strict';

  var unread = 0, summaryRequest;
  var names = {
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
    if (data.unread !== undefined) setCount(data.unread);
    return data;
  }

  function poll() {
    if (document.hidden || summaryRequest) return;
    summaryRequest = request('view=general&limit=1').catch(function () {}).finally(function () { summaryRequest = null; });
  }

  function repairAction(id, parent, initial, kind, onUpdate) {
    var label = kind === 'playback' ? 'Retry playback copy' : 'Repair media';
    var button = node('button', label, parent, 'dashboard-next');
    button.type = 'button';
    var status = node('span', '', parent, 'modal-sub');
    status.setAttribute('role', 'status');
    var link = node('a', 'Open playback copy', parent, 'dashboard-next');
    link.target = '_blank';
    link.rel = 'noopener';
    var pathname = '/api/notifications/' + encodeURIComponent(id) + '/repair';

    function show(result) {
      button.disabled = result?.state === 'running';
      button.textContent = button.disabled ? 'Repairing…' : label;
      status.textContent = result?.message || '';
      link.hidden = !result?.playbackUrl;
      if (result?.playbackUrl) link.href = result.playbackUrl;
      else link.removeAttribute('href');
      onUpdate?.(result);
    }

    async function check() {
      while (button.isConnected && button.disabled) {
        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
        if (!button.isConnected) return;
        try {
          var response = await fetch(pathname);
          if (!response.ok) throw Error('Could not check repair status.');
          show(await response.json());
        } catch (error) {
          show({ message: error.message });
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

  function mount(head, callbacks) {
    var toggle = node('button', 'Notifications', head, 'dashboard-issues-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'dashboard-notifications');
    toggle.setAttribute('aria-expanded', 'false');
    var count = node('span', '', toggle, 'dashboard-issue-badge');
    count.dataset.issueCount = '';
    var pane = node('section', undefined, head, 'dashboard-notifications');
    pane.id = 'dashboard-notifications';
    pane.setAttribute('aria-label', 'Dashboard notifications');
    pane.hidden = true;
    var toolbar = node('div', undefined, pane, 'dashboard-notification-tools');
    node('h3', 'Notifications', toolbar);
    var errors = node('button', 'Errors only', toolbar, 'dashboard-next');
    errors.type = 'button';
    errors.setAttribute('aria-pressed', 'false');
    var mark = node('button', 'Mark all read', toolbar, 'dashboard-next');
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
        var data = await request('view=general&offset=' + (append ? offset : 0) + (errorsOnly ? '&level=error' : ''));
        if (id !== seq || pane.hidden) return;
        if (!append) list.replaceChildren();
        data.issues.forEach(function (issue) { issueRow(issue, list, 'li', callbacks.openItem, message); });
        offset = data.nextOffset;
        more.hidden = offset === null;
        mark.disabled = data.unread === 0;
        message.textContent = data.storageError ? 'Some notifications could not be saved.' : list.children.length ? '' : errorsOnly ? 'No errors recorded.' : 'No warnings or errors recorded.';
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
      toggle.setAttribute('aria-expanded', 'false');
    }

    function show() {
      if (!pane.hidden) return;
      pane.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      message.textContent = 'Loading notifications…';
      load(false);
      interval = setInterval(function () {
        if (!pane.hidden && !document.hidden && !pane.contains(document.activeElement) && pane.scrollTop < 10) load(false);
      }, 5000);
    }

    toggle.onclick = function () { if (pane.hidden) show(); else close(); };
    errors.onclick = function () {
      errorsOnly = !errorsOnly;
      errors.setAttribute('aria-pressed', String(errorsOnly));
      load(false);
    };
    more.onclick = function () { load(true); };
    mark.onclick = async function () {
      mark.disabled = true;
      try {
        var response = await fetch('/api/notifications/read?view=general', {
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
    node('p', 'Retry a failed import or playback copy. Use recovery copies to troubleshoot files outside VidStream.', overview, 'modal-sub');
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

    function paintStatus(row, result) {
      var state = result?.state;
      row.textContent = { running: 'Repairing', completed: 'Repaired', failed: 'Needs review', interrupted: 'Interrupted' }[state] || 'Ready to review';
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
          var row = node('li', undefined, list);
          var button = node('button', undefined, row, 'dashboard-repair-row');
          button.type = 'button';
          var contents = node('span', undefined, button);
          node('strong', issue.path, contents);
          node('small', issueTitle(issue) + ' · ' + new Date(issue.lastAt).toLocaleString(), contents);
          var status = node('span', undefined, button, 'dashboard-repair-state');
          paintStatus(status, issue.repair);
          visible.set(issue.id, status);
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
        if (issue.repairable) repairAction(issue.id, actions, issue.repair, issue.repairKind, function (update) {
          var status = visible.get(id);
          if (status && update?.state) paintStatus(status, update);
        });
        else result.textContent = 'This media is no longer available for repair.';
      } catch (error) {
        if (error.name !== 'AbortError' && requestRef === detailRequest) result.textContent = 'The media issue could not be loaded.';
      }
    }

    refresh.onclick = function () { void load(false); };
    more.onclick = function () { void load(true); };
    return {
      open: function () { root.hidden = false; listScroll = 0; showList(); void load(false); },
      showList: showList,
      showDetail: showDetail,
      close: function () {
        listRequest?.abort();
        detailRequest?.abort();
        listRequest = detailRequest = null;
        detail.replaceChildren();
        root.hidden = true;
      },
    };
  }

  window.StreamDashboardNotifications = { mount: mount, mountRepairs: mountRepairs, poll: poll };
})();
