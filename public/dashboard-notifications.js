(function () {
  'use strict';

  var unread = 0, summaryRequest;
  var names = {
    SCAN_UNSUPPORTED_FORMAT: 'Unsupported file',
    SCAN_FILE_FAILED: 'Media could not be imported',
    SCAN_DIRECTORY_UNREADABLE: 'Directory could not be read',
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

  async function request(query) {
    var response = await fetch('/api/notifications?' + query);
    if (!response.ok) throw Error('Notifications could not load.');
    var data = await response.json();
    setCount(data.unread);
    return data;
  }

  function poll() {
    if (document.hidden || summaryRequest) return;
    summaryRequest = request('limit=1').catch(function () {}).finally(function () { summaryRequest = null; });
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
    var mark = node('button', 'Mark all read', toolbar, 'dashboard-next');
    mark.type = 'button';
    var message = node('p', '', pane, 'modal-sub');
    message.setAttribute('role', 'status');
    var list = node('ul', undefined, pane, 'dashboard-notification-list');
    var more = node('button', 'Load older', pane, 'dashboard-next');
    more.type = 'button';
    more.hidden = true;
    var offset = 0, seq = 0, interval;

    function item(issue) {
      var row = node('li', undefined, list, 'dashboard-notification');
      row.dataset.level = issue.level;
      if (issue.unread) row.dataset.unread = '';
      var top = node('div', undefined, row, 'dashboard-notification-title');
      var title = names[issue.code] || issue.code.toLowerCase().split('_').join(' ').replace(/^./, function (c) { return c.toUpperCase(); });
      node('strong', title, top);
      var time = node('time', new Date(issue.lastAt).toLocaleString(), top, 'mono');
      time.dateTime = new Date(issue.lastAt).toISOString();
      node('p', issue.message, row);
      var meta = node('div', undefined, row, 'dashboard-notification-meta');
      node('code', issue.id + (issue.occurrences > 1 ? ' · ' + issue.occurrences + ' occurrences' : ''), meta);
      if (issue.stage) node('span', issue.stage, meta);
      if (!issue.path) return;
      node('code', issue.path, row, 'dashboard-issue-path').title = 'Path relative to the media mount';
      var actions = node('div', undefined, row, 'dashboard-notification-actions');
      if (issue.itemId) {
        var open = node('button', 'Open media', actions, 'dashboard-next');
        open.type = 'button';
        open.onclick = function () { callbacks.openItem(issue.itemId); };
      }
      var copy = node('button', 'Copy path', actions, 'dashboard-next');
      copy.type = 'button';
      copy.onclick = async function () {
        if (navigator.clipboard) {
          try { await navigator.clipboard.writeText(issue.path); message.textContent = 'Path copied.'; return; } catch (_) {}
        }
        var selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(row.querySelector('.dashboard-issue-path'));
        selection.removeAllRanges(); selection.addRange(range);
        message.textContent = 'Path selected. Use your usual copy shortcut.';
      };
    }

    async function load(append) {
      var id = ++seq;
      more.disabled = true;
      try {
        var data = await request('offset=' + (append ? offset : 0));
        if (id !== seq || pane.hidden) return;
        if (!append) list.replaceChildren();
        data.issues.forEach(item);
        offset = data.nextOffset;
        more.hidden = offset === null;
        mark.disabled = data.unread === 0;
        message.textContent = data.storageError ? 'Some notifications could not be saved.' : list.children.length ? '' : 'No warnings or errors recorded.';
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
    more.onclick = function () { load(true); };
    mark.onclick = async function () {
      mark.disabled = true;
      try {
        var response = await fetch('/api/notifications/read', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!response.ok) throw Error('Could not mark notifications read.');
        await load(false);
      } catch (error) { message.textContent = error.message; mark.disabled = false; }
    };
    setCount(unread);
    return { open: show, close: close, isOpen: function () { return !pane.hidden; } };
  }

  window.StreamDashboardNotifications = { mount: mount, poll: poll };
})();
