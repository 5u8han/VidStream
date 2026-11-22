(function () {
  'use strict';
  var config = JSON.parse(document.getElementById('app').dataset.config || '{}');
  var dialog, returnFocus, adapter = {}, pendingUI = {}, saveTimer;
  try { pendingUI = JSON.parse(localStorage.getItem('stream-ui-pending') || '{}'); } catch (_) {}
  var deviceKeys = ['stream-data-saver', 'stream-lightweight', 'stream-max-previews', 'stream-preview-source', 'stream-preview-memory', 'stream-viewer-blur', 'stream-video-stats', 'stream-effects', 'stream-saved-filters', 'stream-pinned-actions'];
  deviceKeys.forEach(function (key) { delete pendingUI[key]; });
  Object.entries(Object.assign({}, config.savedUI || {}, pendingUI)).filter(function (entry) {
    return !deviceKeys.includes(entry[0]);
  }).forEach(function (entry) { try { localStorage.setItem(entry[0], entry[1]); } catch (_) {} });
  try {
    var theme = localStorage.getItem('stream-theme') || config.defaultTheme;
    if (theme && theme !== 'system') document.documentElement.dataset.theme = theme;
    else document.documentElement.removeAttribute('data-theme');
    var density = localStorage.getItem('stream-density');
    if (density) document.documentElement.dataset.density = density;
  } catch (_) {}
  window.StreamActivity?.setEnabled(config.tracking !== false);

  function node(tag, text, parent, className) {
    var element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    if (parent) parent.appendChild(element);
    return element;
  }
  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }
  function message(value, failed, owner) {
    var current = owner || dialog;
    if (!current?.open) return;
    current._status.textContent = value;
    current._status.classList.toggle('is-error', Boolean(failed));
  }
  function button(label, parent, action, className) {
    var element = node('button', label, parent, className);
    element.type = 'button';
    element.addEventListener('click', async function () {
      var owner = element.closest('dialog');
      if (element.disabled) return;
      try {
        var result = action();
        if (result && typeof result.then === 'function') {
          element.disabled = true;
          await result;
        }
      } catch (error) {
        if (error.name !== 'AbortError') message(error.message, true, owner);
      } finally { if (element.isConnected) element.disabled = false; }
    });
    return element;
  }
  async function api(url, body, owner) {
    var controller = new AbortController();
    function closed() { if (!owner.open) controller.abort(); }
    if (owner) owner.addEventListener('close', closed);
    try {
      var response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw Error(result.error || (response.status === 401 ? 'Sign in again to manage this library.' : 'Could not save this setting.'));
      return result;
    } finally { if (owner) owner.removeEventListener('close', closed); }
  }
  function settingsTrigger() {
    return document.querySelector('.header button[aria-label="Settings"]');
  }
  function closeSettings(current) {
    if (window.StreamNavigation?.has('settings')) window.StreamNavigation.leave('settings');
    else current.close();
  }
  function shell(anchor) {
    if (dialog) dialog.remove();
    returnFocus = anchor || settingsTrigger() || document.activeElement;
    var current = node('dialog', undefined, document.body, 'stream-settings settings-flat');
    dialog = current;
    current.id = 'stream-settings';
    current.setAttribute('aria-labelledby', 'settings-title');
    var header = node('header', undefined, current, 'settings-header');
    var title = node('h2', 'Settings', header);
    title.id = 'settings-title';
    title.tabIndex = -1;
    var close = button('×', header, function () { closeSettings(current); }, 'settings-close');
    close.setAttribute('aria-label', 'Close settings');
    var content = node('div', undefined, current, 'settings-content');
    var footer = node('footer', undefined, current, 'settings-footer');
    current._status = node('p', '', footer, 'settings-status');
    current._status.setAttribute('role', 'status');
    var build = node('section', undefined, footer, 'settings-build-info');
    build.setAttribute('aria-label', 'Running application');
    node('strong', 'VidStream ' + (config.version || 'unknown version'), build);
    node('small', location.origin, build);

    var afterClose;
    function outside(event) {
      if (current.contains(event.target)) return;
      var target = event.target.closest('.header button, .lightbox-bar button');
      if (target && target !== returnFocus) afterClose = target;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettings(current);
    }
    function positionPanel() {
      var activeAnchor = returnFocus?.isConnected ? returnFocus : settingsTrigger();
      var toolbar = activeAnchor?.closest('.lightbox-bar, .header');
      var bottom = toolbar?.getBoundingClientRect().bottom || 0;
      var anchor = activeAnchor?.getBoundingClientRect();
      var center = anchor ? anchor.left + anchor.width / 2 : innerWidth / 2;
      var width = Math.min(innerWidth <= 900 ? 690 : 798, innerWidth - 16);
      var left = Math.max(8, Math.min(center - width / 2, innerWidth - width - 8));
      current.style.setProperty('--controls-top', Math.max(8, bottom + 8) + 'px');
      current.style.setProperty('--controls-left', left + 'px');
    }
    function show() {
      if (!current.isConnected) return false;
      dialog = current;
      positionPanel();
      if (!current.open) current.show();
      returnFocus?.setAttribute('aria-expanded', 'true');
      window.addEventListener('resize', positionPanel);
      document.addEventListener('click', outside, true);
      title.focus({ preventScroll: true });
      current._resume?.();
    }
    current.addEventListener('cancel', function (event) { event.preventDefault(); closeSettings(current); });
    current.addEventListener('keydown', function (event) { event.stopPropagation(); });
    current.addEventListener('close', function () {
      if (current.open || current !== dialog) return;
      window.removeEventListener('resize', positionPanel);
      document.removeEventListener('click', outside, true);
      returnFocus?.setAttribute('aria-expanded', 'false');
      returnFocus?.focus({ preventScroll: true });
      if (afterClose) {
        var next = afterClose; afterClose = null;
        queueMicrotask(function () { if (next.isConnected) next.click(); });
      }
    });
    if (window.StreamNavigation && !window.StreamNavigation.enter('settings', {
      back: function () { if (current.open) current.close(); },
      forward: show
    })) { current.remove(); return null; }
    show();
    return content;
  }
  function card(parent, title) {
    var section = node('section', undefined, parent, 'settings-card');
    node('h3', title, section);
    return section;
  }
  function choices(parent, label, values, selected, apply, className) {
    var group = node('fieldset', undefined, parent, 'settings-choice-field ' + (className || ''));
    node('legend', label, group);
    var row = node('div', undefined, group, 'settings-choices');
    if (!values.some(function (value) { return value[0] === selected; })) selected = values[0][0];
    values.forEach(function (value) {
      var choice = button(value[1], row, function () {
        apply(value[0]);
        row.querySelectorAll('button').forEach(function (entry) {
          entry.setAttribute('aria-pressed', String(entry === choice));
        });
      }, 'settings-choice');
      choice.dataset.value = value[0];
      choice.setAttribute('aria-pressed', String(selected === value[0]));
      if (value[2]) choice.style.setProperty('--choice-color', value[2]);
    });
    return group;
  }
  function toggle(parent, label, description, checked, apply) {
    var wrap = node('label', undefined, parent, 'settings-toggle-row');
    var copy = node('span', undefined, wrap, 'settings-toggle-copy');
    node('strong', label, copy);
    if (description) node('small', description, copy);
    var input = node('input', undefined, wrap);
    input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label);
    node('span', undefined, wrap, 'settings-toggle-track').setAttribute('aria-hidden', 'true');
    input.addEventListener('change', async function () {
      var wanted = input.checked, owner = input.closest('dialog');
      try {
        var result = apply(wanted);
        if (result && typeof result.then === 'function') { input.disabled = true; await result; }
      } catch (error) {
        input.checked = !wanted;
        if (error.name !== 'AbortError') message(error.message, true, owner);
      } finally { input.disabled = false; }
    });
    return input;
  }
  function tabs(parent) {
    var current = dialog;
    var bar = node('div', undefined, parent, 'settings-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Settings sections');
    var sections = new Map(), active;
    function select(name, focus) {
      var section = sections.get(name) || sections.get('gallery');
      if (!section) return;
      if (active === section) return;
      if (active?.initialize && !active.keep) {
        active.pane.replaceChildren();
        active.loaded = false;
      }
      active = section;
      current.scrollTop = 0;
      sections.forEach(function (entry) {
        var selected = entry === active;
        entry.pane.hidden = !selected;
        entry.tab.tabIndex = selected ? 0 : -1;
        entry.tab.setAttribute('aria-selected', String(selected));
      });
      if (focus) section.tab.focus({ preventScroll: true });
      if (bar.scrollWidth > bar.clientWidth) bar.scrollLeft += section.tab.getBoundingClientRect().left - bar.getBoundingClientRect().left - (bar.clientWidth - section.tab.offsetWidth) / 2;
      if (!section.loaded && section.initialize) {
        section.loaded = true;
        var pane = node('div', undefined, section.pane, 'settings-tool-body');
        Promise.resolve().then(function () { return section.initialize(pane); }).catch(function (error) {
          if (pane.isConnected) {
            section.loaded = false;
            pane.remove();
            message(error.message, true, current);
          }
        });
      }
    }
    function add(id, label, initialize, keep) {
      var tab = button(label, bar, function () { select(id, true); });
      tab.id = 'settings-tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'settings-' + id);
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      var pane = node('section', undefined, parent, initialize ? 'settings-tool-pane' : 'settings-preferences');
      pane.id = 'settings-' + id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', tab.id);
      pane.hidden = true;
      sections.set(id, { tab: tab, pane: pane, initialize: initialize, keep: keep });
      return pane;
    }
    bar.addEventListener('keydown', function (event) {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      var names = Array.from(sections.keys());
      var index = names.findIndex(function (id) { return sections.get(id) === active; });
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = names.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
      event.preventDefault();
      select(names[index], true);
    });
    function categoryGesture(target) {
      return target.closest('[role="tabpanel"]') &&
        !target.closest('input, select, textarea, button, a, pre, [contenteditable], [data-no-swipe]');
    }
    function step(direction) {
      var entries = Array.from(sections.entries());
      var index = entries.findIndex(function (entry) { return entry[1] === active; });
      var next = entries[index + direction];
      if (next) select(next[0], true);
    }
    var touch;
    parent.addEventListener('touchstart', function (event) {
      touch = null;
      if (event.touches.length !== 1 || !categoryGesture(event.target)) return;
      var point = event.touches[0];
      if (point.clientX < 20 || point.clientX > innerWidth - 20) return;
      touch = { x: point.clientX, y: point.clientY, id: point.identifier };
    }, { passive: true });
    parent.addEventListener('touchcancel', function () { touch = null; }, { passive: true });
    parent.addEventListener('touchend', function (event) {
      var start = touch;
      touch = null;
      if (!start || event.touches.length) return;
      var point = Array.from(event.changedTouches).find(function (item) { return item.identifier === start.id; });
      if (!point) return;
      var dx = point.clientX - start.x, dy = point.clientY - start.y;
      if (Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy) * 2) step(dx < 0 ? 1 : -1);
    }, { passive: true });
    var wheelTime = 0, travel = 0, stepped = false;
    parent.addEventListener('wheel', function (event) {
      if (event.ctrlKey || !categoryGesture(event.target) || !event.deltaX ||
          Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 2) return;
      var now = performance.now();
      if (now - wheelTime > 240) { travel = 0; stepped = false; }
      wheelTime = now;
      if (event.cancelable) event.preventDefault();
      if (stepped) return;
      travel += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? parent.clientWidth : 1);
      if (Math.abs(travel) >= 80) { stepped = true; step(travel > 0 ? 1 : -1); }
    }, { passive: false });
    function refresh() {
      if (!active?.initialize || active.keep) return;
      var name = Array.from(sections.keys()).find(function (id) { return sections.get(id) === active; });
      active.pane.replaceChildren();
      active.loaded = false;
      active = null;
      select(name);
    }
    return { add: add, select: select, refresh: refresh };
  }
  async function scanning(pane, owner) {
    var data = await api('/api/settings/scanning', undefined, owner);
    if (!pane.isConnected || !owner.open) return;
    node('p', 'These settings apply to this VidStream server. Saved choices take priority over its deployment settings.', pane, 'settings-footnote');
    var form = node('form', undefined, pane);
    var fields = node('fieldset', undefined, form, 'settings-choice-field');
    node('legend', 'Scan scheduling', fields);
    function selector(title, help, options, value) {
      var label = node('label', undefined, fields, 'settings-scan-field');
      node('strong', title, label);
      var select = node('select', undefined, label);
      select.setAttribute('aria-label', title);
      var hintId = 'scan-schedule-' + title.toLowerCase().replace(/\W+/g, '-') + '-help';
      select.setAttribute('aria-describedby', hintId);
      options.forEach(function (option) { node('option', option[1], select).value = option[0]; });
      select.value = value;
      node('small', help, label).id = hintId;
      return select;
    }
    function flag(key, title, help, on, off) {
      return selector(title, help, [
        ['default', 'Use deployment setting (' + (data.defaults[key] ? on : off) + ')'], ['on', on], ['off', off]
      ], data.overrides[key] === undefined ? 'default' : data.effective[key] ? 'on' : 'off');
    }
    var startup = flag('scanOnStart', 'When VidStream starts',
      'Applies the next time VidStream starts. A new library or changed mount can still need a scan.', 'Scan media', 'Open saved catalog');
    var watcher = flag('watchForChanges', 'Watch folders for changes',
      'Enabling file watching may walk the media folders to register watchers.', 'On', 'Off');
    var presets = [['0', 'Off'], ['15', 'Every 15 minutes'], ['30', 'Every 30 minutes'],
      ['60', 'Every hour'], ['360', 'Every 6 hours'], ['720', 'Every 12 hours'],
      ['1440', 'Daily'], ['10080', 'Weekly']];
    var currentInterval = data.overrides.rescanIntervalMinutes;
    var defaultInterval = data.defaults.rescanIntervalMinutes;
    var interval = selector('Scheduled rescans', 'The countdown resets when the interval changes.', [['default',
      'Use deployment setting (' + (defaultInterval ? 'every ' + defaultInterval + ' min' : 'Off') + ')']]
      .concat(presets, [['custom', 'Custom interval']]), currentInterval === undefined ? 'default' :
      presets.some(function (preset) { return Number(preset[0]) === currentInterval; }) ? String(currentInterval) : 'custom');
    var customLabel = node('label', undefined, fields, 'settings-scan-field');
    node('strong', 'Custom interval in minutes', customLabel);
    var custom = node('input', undefined, customLabel);
    custom.type = 'number';
    custom.min = '1'; custom.max = String(data.maxIntervalMinutes); custom.step = '1';
    custom.value = String(currentInterval || 60);
    function toggleCustom() {
      customLabel.hidden = custom.disabled = interval.value !== 'custom';
      custom.required = !custom.disabled;
    }
    interval.addEventListener('change', toggleCustom);
    toggleCustom();
    var save = node('button', 'Save scan schedule', fields, 'settings-small-button');
    save.type = 'submit';
    function boolValue(value) { return value === 'default' ? null : value === 'on'; }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var payload = { scanOnStart: boolValue(startup.value), watchForChanges: boolValue(watcher.value),
        rescanIntervalMinutes: interval.value === 'default' ? null : interval.value === 'custom' ? custom.valueAsNumber : Number(interval.value) };
      fields.disabled = true;
      try {
        await api('/api/settings/scanning', payload, owner);
        if (pane.isConnected) message('Scan schedule saved.', false, owner);
      } catch (error) {
        if (pane.isConnected && error.name !== 'AbortError') message(error.message, true, owner);
      } finally { fields.disabled = false; }
    });
  }
  async function updates(pane, owner) {
    node('p', 'Updates come from VidStream on GitHub. Playback may pause briefly when this machine starts the new build.', pane, 'settings-footnote');
    var installed = node('p', 'Reading installed build…', pane, 'settings-footnote');
    var state = node('p', '', pane, 'settings-status');
    state.setAttribute('role', 'status');
    var helper = node('p', '', pane, 'settings-footnote');
    var actions = node('div', undefined, pane, 'settings-choices');
    var check = node('button', 'Check for updates', actions, 'settings-small-button');
    var apply = node('button', 'Install update', actions, 'settings-small-button');
    var reload = button('Reload VidStream', actions, function () { location.reload(); }, 'settings-small-button');
    check.type = apply.type = 'button';
    check.disabled = true;
    apply.hidden = reload.hidden = true;
    var timer, pending = false, disconnectedAt = 0, lastState, sawInstall = false;

    function alive() { return pane.isConnected && owner.open; }
    function active(data) { return data?.state === 'checking' || data?.state === 'updating'; }
    function schedule(delay) {
      clearTimeout(timer);
      if (alive()) timer = setTimeout(refresh, delay);
    }
    function paint(data) {
      lastState = data;
      var build = data.currentRevision ? data.currentRevision.slice(0, 12) : 'revision unknown';
      installed.textContent = 'Running ' + (data.version || config.version) + ' · ' + build;
      if (data.targetRevision && data.targetRevision !== data.currentRevision)
        installed.textContent += ' · GitHub main ' + data.targetRevision.slice(0, 12);
      state.textContent = data.message || 'Check for a newer build.';
      state.classList.toggle('is-error', data.state === 'failed');
      helper.textContent = data.connected ? 'The host update helper is connected.' : data.managed
        ? 'To reconnect the update helper, open Start-Here on this host and choose Start existing VidStream.'
        : 'Browser installation is available for a guided Git checkout using Start-Here. Other installations can check here and update through their usual deployment tools.';
      check.disabled = pending || active(data);
      apply.disabled = pending || active(data);
      apply.hidden = !data.canUpdate;
      if (data.state === 'updating') sawInstall = true;
      var loadedCurrent = config.buildRevision && config.buildRevision === data.currentRevision;
      reload.hidden = data.state !== 'completed' || loadedCurrent || (!config.buildRevision && !sawInstall);
      if (data.state === 'completed' && reload.hidden) state.textContent = 'You are running the updated build.';
    }
    async function refresh() {
      clearTimeout(timer);
      if (!alive() || pending) return;
      try {
        var response = await fetch('/api/updates', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        if (!alive() || pending) return;
        if (response.status === 401 || response.status === 403) {
          state.textContent = 'Sign in again to check this server.';
          check.disabled = true;
          apply.hidden = true;
          reload.hidden = false;
          return;
        }
        if (!response.ok) throw Error('Update status is unavailable.');
        var data = await response.json();
        if (!alive() || pending) return;
        disconnectedAt = 0;
        paint(data);
        if (active(data)) schedule(2000);
      } catch (error) {
        if (!alive() || pending) return;
        if (active(lastState)) {
          disconnectedAt ||= Date.now();
          if (Date.now() - disconnectedAt < 5 * 60 * 1000) {
            state.textContent = 'Waiting for VidStream to reconnect…';
            schedule(2000);
            return;
          }
          state.textContent = 'VidStream has not reconnected. Check Start-Here on the host, then try again.';
        } else state.textContent = error.message || 'Update status is unavailable.';
        check.disabled = false;
        apply.hidden = true;
      }
    }
    async function request(action) {
      if (!alive() || pending) return;
      clearTimeout(timer);
      pending = true;
      check.disabled = apply.disabled = true;
      reload.hidden = true;
      state.textContent = action === 'apply' ? 'Contacting the host…' : 'Checking GitHub…';
      try {
        var data = await api('/api/updates/' + action, {}, owner);
        if (!alive()) return;
        pending = false;
        paint(data);
        if (active(data)) schedule(1000);
      } catch (error) {
        if (!alive()) return;
        pending = false;
        state.textContent = error.message;
        check.disabled = false;
        apply.hidden = true;
        if (action === 'apply') {
          lastState = { state: 'updating' };
          schedule(1500);
        }
      }
    }
    check.onclick = function () { void request('check'); };
    apply.onclick = function () { void request('apply'); };
    owner.addEventListener('close', function () { clearTimeout(timer); }, { once: true });
    await refresh();
  }
  async function open(section, origin) {
    if (!config.isAdmin) return;
    var event = typeof section === 'object' ? section : null;
    var anchor = origin || event?.currentTarget?.closest('button') || settingsTrigger();
    var requested = typeof section === 'string' ? section : 'gallery';
    if (requested === 'preferences') requested = 'gallery';
    if (dialog?.open) {
      if (typeof section === 'string') dialog._tabs.select(requested, true);
      else closeSettings(dialog);
      return;
    }
    var body = shell(anchor);
    if (!body) return;
    var current = dialog;
    var tabsMenu = current._tabs = tabs(body);
    var gallery = tabsMenu.add('gallery', 'Gallery');
    var playback = tabsMenu.add('playback', 'Playback');
    var playerCards = node('div', undefined, playback, 'settings-card-grid view-panel');
    adapter.mountGalleryControls(gallery, playerCards);
    var appearance = card(gallery, 'Appearance');
    choices(appearance, 'Theme', [
      ['system', 'System'], ['light-table', 'Light', '#a83831'], ['darkroom', 'Dark', '#c1443c'],
      ['golden-hour', 'Warm', '#d68c33'], ['contact-sheet', 'Cool', '#2f4c6b']
    ], read('stream-theme', config.defaultTheme || 'system'), function (value) { adapter.theme?.(value); }, 'settings-theme-choices');
    choices(appearance, 'Animations and effects', [['off', 'Off'], ['subtle', 'Subtle'], ['full', 'Full']], read('stream-effects', document.documentElement.dataset.effects || 'full'), function (value) { adapter.effects?.(value); });
    node('p', 'Choose Off to disable interface animations and visual effects on this browser.', appearance, 'settings-footnote');
    var player = card(playerCards, 'Video player');
    var blurLabel = node('label', undefined, player, 'settings-slider-label');
    node('span', 'Viewer background blur', blurLabel);
    var blurValue = node('output', '', blurLabel);
    var blur = node('input', undefined, blurLabel, 'settings-range');
    blur.type = 'range'; blur.min = '0'; blur.max = '30'; blur.step = '1';
    blur.setAttribute('aria-label', 'Viewer background blur');
    blur.value = String(Math.max(0, Math.min(30, Number(read('stream-viewer-blur', '10')) || 0)));
    function paintBlur() { blurValue.value = blur.value + ' px'; blur.setAttribute('aria-valuetext', blur.value + ' pixels'); }
    paintBlur();
    blur.oninput = function () { paintBlur(); adapter.viewerBlur?.(blur.value); };
    toggle(player, 'Show Stats for nerds in video player', 'Resolution, frame rate and playback details.', read('stream-video-stats', '0') === '1', function (value) { adapter.videoStats?.(value); });

    tabsMenu.add('folders', 'Host & folders', function (pane) {
      var hostArea = node('div', undefined, pane);
      var mountArea = node('div', undefined, pane);
      window.StreamHostSettings.mount(hostArea, current);
      return window.StreamFolders.settings(mountArea);
    }, true);
    if (window.StreamNodes) {
      tabsMenu.add('nodes', 'Nodes', function (pane) { return window.StreamNodes.settings(pane); });
    }
    tabsMenu.add('scanning', 'Indexing', function (pane) { return scanning(pane, current); }, true);
    tabsMenu.add('maintenance', 'Storage & backup', function (pane) { return window.StreamLibraryTools.maintenance(pane); });
    tabsMenu.add('updates', 'Updates', function (pane) { return updates(pane, current); });
    var activity = tabsMenu.add('history', 'Account & history', function (pane) {
      var list = node('div', undefined, pane, 'settings-activity-list'), cursor = null, loaded = false;
      var more = button('Load more activity', pane, async function () {
        var page = await api('/api/activity' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), undefined, current);
        if (!current.open) return;
        if (!loaded && !page.events.length) node('p', 'No activity recorded yet.', list, 'settings-footnote');
        page.events.forEach(function (event) {
          var row = node('article', undefined, list);
          node('strong', event.path, row);
          node('small', event.action + ' · ' + new Date(event.occurred_at).toLocaleString(), row);
        });
        loaded = true; cursor = page.next; more.disabled = !cursor; more.hidden = !cursor;
      }, 'settings-small-button');
      more.click();
    }, true);
    var accountGrid = node('div', undefined, activity, 'settings-card-grid');
    var library = card(accountGrid, 'Viewing history');
    var tracking = toggle(library, 'Record media activity', 'Save intentional hovers, opens, and viewing activity. Playback position is saved separately.', config.tracking !== false, async function (value) {
      await api('/api/settings', { tracking: value }, current);
      window.StreamActivity?.setEnabled(value);
      message(value ? 'Viewing history is on.' : 'Viewing history is off.', false, current);
    });
    tracking.disabled = true;
    var pending = window.StreamActivity?.pending() || 0;
    var loadNote = node('p', 'Loading library settings…', library, 'settings-footnote');
    if (pending) node('p', pending + ' activity records waiting to sync from this browser.', library, 'settings-footnote');
    var retry = button('Retry library settings', library, function () { return hydrate(); }, 'settings-small-button'); retry.hidden = true;
    var access = card(accountGrid, 'Sign-in');
    var account = node('p', 'Loading account…', access, 'settings-footnote');
    button('Sign out', access, function () { return window.StreamSignOut(); }, 'settings-signout');
    var loaded = false, loading = false;
    async function hydrate() {
      if (loading || loaded) return;
      loading = true; retry.hidden = true;
      try {
        var data = await api('/api/settings', undefined, current);
        if (!current.open || current !== dialog) return;
        loaded = true;
        tracking.checked = data.tracking !== false; tracking.disabled = false;
        window.StreamActivity?.setEnabled(data.tracking !== false);
        account.textContent = data.security?.mode || 'Passphrase sign-in';
        loadNote.textContent = 'History stays with this server across devices and updates.';
      } catch (error) {
        if (error.name !== 'AbortError') {
          loadNote.textContent = 'Library settings could not load. Your browser controls still work.';
          account.textContent = 'Account settings unavailable.';
          retry.hidden = false;
          message(error.message, true, current);
        }
      } finally { loading = false; }
    }
    current._resume = function () {
      void hydrate();
      tabsMenu.refresh();
    };
    tabsMenu.select(requested, requested !== 'gallery');
    await hydrate();
  }
  function savePending() { try { localStorage.setItem('stream-ui-pending', JSON.stringify(pendingUI)); } catch (_) {} }
  async function syncPreferences() {
    if (!config.isAdmin || !Object.keys(pendingUI).length) return;
    var values = Object.assign({}, pendingUI);
    try {
      await api('/api/settings', { ui: values });
      Object.keys(values).forEach(function (key) { if (pendingUI[key] === values[key]) delete pendingUI[key]; });
      savePending();
    } catch (error) { console.warn('View preferences waiting to sync:', error.message); }
    if (Object.keys(pendingUI).length) saveTimer = setTimeout(syncPreferences, 5000);
  }
  function preference(key, value) {
    if (!config.isAdmin || deviceKeys.includes(key)) return;
    pendingUI[key] = String(value); savePending(); clearTimeout(saveTimer); saveTimer = setTimeout(syncPreferences, 500);
  }
  if (Object.keys(pendingUI).length) saveTimer = setTimeout(syncPreferences, 500);
  document.addEventListener('keydown', function (event) {
    if (!config.isAdmin) return;
    if (dialog?.open) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeSettings(dialog); }
      return;
    }
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      settingsTrigger()?.click();
    }
  }, true);
  window.StreamSettings = {
    dismissThen: function (action) {
      if (!dialog?.open) return action();
      dialog.addEventListener('close', action, { once: true });
      closeSettings(dialog);
    },
    open: function (section, origin) { void open(section, origin).catch(function (error) { message(error.message, true); }); },
    preference: preference,
    init: function (value) { adapter = value; }
  };
})();
