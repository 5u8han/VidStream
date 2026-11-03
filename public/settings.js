(function () {
  'use strict';
  var config = JSON.parse(document.getElementById('app').dataset.config || '{}');
  var dialog, returnFocus, adapter = {}, pendingUI = {}, saveTimer;
  try { pendingUI = JSON.parse(localStorage.getItem('stream-ui-pending') || '{}'); } catch (_) {}
  var deviceKeys = ['stream-data-saver', 'stream-max-previews', 'stream-preview-source', 'stream-viewer-blur', 'stream-video-stats', 'stream-effects', 'stream-saved-filters', 'stream-pinned-actions'];
  deviceKeys.forEach(function (key) { delete pendingUI[key]; });
  Object.entries(Object.assign({}, config.savedUI || {}, pendingUI)).filter(function (entry) {
    return !deviceKeys.includes(entry[0]);
  }).forEach(function (entry) { try { localStorage.setItem(entry[0], entry[1]); } catch (_) {} });
  try {
    var theme = localStorage.getItem('stream-theme');
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
  function closeSettings(current) {
    if (window.StreamNavigation?.has('settings')) window.StreamNavigation.leave('settings');
    else current.close();
  }
  function stepBack() {
    if (window.StreamNavigation?.has('settings')) window.StreamNavigation.back();
    else if (dialog?._back) dialog._back();
  }
  function shell() {
    if (dialog) dialog.remove();
    returnFocus = document.activeElement;
    var current = node('dialog', undefined, document.body, 'stream-settings settings-flat');
    dialog = current;
    current.setAttribute('aria-labelledby', 'settings-title');
    var header = node('header', undefined, current, 'settings-header');
    var titleGroup = node('div', undefined, header);
    node('p', 'MAKE YOURSELF AT HOME', titleGroup, 'settings-eyebrow');
    var title = node('h2', 'Settings', titleGroup); title.id = 'settings-title';
    var close = button('Close', header, function () { closeSettings(current); }, 'settings-close');
    close.setAttribute('aria-label', 'Close settings');
    var content = node('div', undefined, current, 'settings-content');
    var footer = node('footer', undefined, current, 'settings-footer');
    current._status = node('p', '', footer, 'settings-status');
    current._status.setAttribute('role', 'status');
    current._status.setAttribute('aria-live', 'polite');
    var build = node('section', undefined, footer, 'settings-build-info');
    build.setAttribute('aria-label', 'Running application');
    node('strong', 'VidStream ' + (config.version || 'unknown version'), build);
    node('span', config.isAdmin ? 'Signed in as owner' : 'Guest view', build);
    node('small', location.origin + ' · ' + (config.features?.nodes ? 'Nodes included' : 'Single-library build'), build);
    current._back = function () {
      var expanded = Array.from(current.querySelectorAll('details[open]')).pop();
      if (expanded) expanded.open = false;
      else current.close();
    };
    current.addEventListener('cancel', function (event) { event.preventDefault(); stepBack(); });
    current.addEventListener('keydown', function (event) { event.stopPropagation(); });
    current.addEventListener('close', function () {
      // Native close events are queued. Forward may already have reopened
      // this dialog before an earlier close event is delivered.
      if (current.open) return;
      if (window.StreamNavigation?.has('settings')) window.StreamNavigation.leave('settings');
      returnFocus?.focus({ preventScroll: true });
    });
    current.addEventListener('click', function (event) {
      var bounds = current.getBoundingClientRect();
      if (event.target === current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) stepBack();
    });
    if (window.StreamNavigation && !window.StreamNavigation.enter('settings', {
      back: function () { if (current.open) current.close(); },
      forward: function () {
        if (!current.isConnected) return false;
        dialog = current;
        if (!current.open) current.showModal();
        current._resume?.();
      }
    })) { current.remove(); return null; }
    current.showModal();
    return content;
  }
  function card(parent, title, description, className) {
    var section = node('section', undefined, parent, 'settings-card ' + (className || ''));
    node('h3', title, section);
    if (description) node('p', description, section, 'settings-caption');
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
  function advanced(parent, name, description, initialize) {
    var current = dialog, id = name === 'Library tools' ? 'settings-maintenance' : 'settings-' + name.toLowerCase().replace(/\W+/g, '-');
    var details = node('details', undefined, parent, 'settings-detail');
    details.id = id;
    var summary = node('summary', undefined, details);
    var text = node('span', undefined, summary);
    node('strong', name, text); node('small', description, text);
    node('span', '+', summary, 'settings-detail-mark').setAttribute('aria-hidden', 'true');
    var pane = node('section', undefined, details, 'settings-detail-content settings-pane');
    pane.setAttribute('aria-label', name); pane.hidden = true;
    var initialized = false;
    current.addEventListener('close', function () {
      if (current.open) return;
      initialized = false;
      pane.remove();
      pane = node('section', undefined, details, 'settings-detail-content settings-pane');
      pane.setAttribute('aria-label', name); pane.hidden = !details.open;
    });
    function load() {
      if (initialized) return;
      initialized = true;
      Promise.resolve().then(function () { return initialize(pane); }).catch(function (error) {
        initialized = false;
        message(error.message, true, current);
      });
    }
    details._restore = function () {
      current._activeDetail = details; current._lastDetail = details;
      details.open = true; pane.hidden = false; load();
    };
    details._hide = function () { details.open = false; pane.hidden = true; };
    details.addEventListener('toggle', function () {
      pane.hidden = !details.open;
      if (!current.open) return;
      if (details.open) {
        // All advanced cards share one navigation level. Switching cards is
        // a direct replacement, so Back never walks through a stack of cards.
        if (window.StreamNavigation && !window.StreamNavigation.has('settings-detail')) {
          var entered = window.StreamNavigation.enter('settings-detail', {
            back: function () {
              var active = current._activeDetail || current._lastDetail;
              current._activeDetail = null;
              if (active) { active._hide(); active.querySelector('summary').focus({ preventScroll: true }); }
            },
            forward: function () {
              if (!current._lastDetail?.isConnected) return false;
              current._lastDetail._restore();
            }
          });
          if (!entered) { details.open = false; return; }
        }
        current._activeDetail = details; current._lastDetail = details;
        parent.querySelectorAll('.settings-detail[open]').forEach(function (other) {
          if (other !== details) other._hide();
        });
        load();
      } else if (current._activeDetail === details) {
        if (window.StreamNavigation?.has('settings-detail')) window.StreamNavigation.leave('settings-detail');
        else current._activeDetail = null;
      }
    });
    return details;
  }
  async function open() {
    if (dialog?.open) return;
    var body = shell();
    if (!body) return;
    var current = dialog;
    node('p', 'Your everyday controls, all in one place. Changes apply immediately.', body, 'settings-intro');
    var grid = node('div', undefined, body, 'settings-card-grid');
    var appearance = card(grid, 'Appearance', 'A look that feels right on this screen.');
    choices(appearance, 'Theme', [
      ['system', 'System'], ['light-table', 'Light', '#a83831'], ['darkroom', 'Dark', '#c1443c'],
      ['golden-hour', 'Warm', '#d68c33'], ['contact-sheet', 'Cool', '#2f4c6b']
    ], read('stream-theme', 'system'), function (value) { adapter.theme?.(value); }, 'settings-theme-choices');
    choices(appearance, 'Visual effects', [['off', 'Off'], ['subtle', 'Subtle'], ['full', 'Full']], read('stream-effects', document.documentElement.dataset.effects || 'full'), function (value) { adapter.effects?.(value); });
    node('p', 'Effects stay on this browser. Reduced motion is always respected.', appearance, 'settings-footnote');
    var player = card(grid, 'Video player', 'Keep the gallery visible around your video.');
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

    var tracking, lock, account, loadNote, retry;
    if (config.isAdmin) {
      var library = card(grid, 'Library', 'Keep your place across this library.');
      tracking = toggle(library, 'Record media activity', 'Save intentional hovers, opens and viewing progress.', config.tracking !== false, async function (value) {
        await api('/api/settings', { tracking: value }, current);
        window.StreamActivity?.setEnabled(value);
        message(value ? 'Viewing history is on.' : 'Viewing history is off.', false, current);
      });
      tracking.disabled = true;
      var pending = window.StreamActivity?.pending() || 0;
      loadNote = node('p', 'Loading library settings…', library, 'settings-footnote');
      if (pending) node('p', pending + ' activity records waiting to sync from this browser.', library, 'settings-footnote');
      retry = button('Retry library settings', library, function () { return hydrate(); }, 'settings-small-button'); retry.hidden = true;
      var access = card(grid, 'Access', 'Control who can view this server.');
      lock = toggle(access, 'Require sign-in for the entire library', 'Only signed-in people can browse when enabled.', true, async function (value) {
        await api('/api/settings', { requireLogin: value }, current);
        message(value ? 'Library sign-in is required.' : 'Only items explicitly shared with guests are public.', false, current);
      });
      lock.disabled = true;
      account = node('p', 'Loading account…', access, 'settings-footnote');
      button('Sign out', access, async function () { await api('/api/logout', {}, current); location.href = '/'; }, 'settings-signout');
    }
    var tools = node('div', undefined, body, 'settings-details');
    if (config.features?.nodes || window.StreamNodes) {
      advanced(tools, 'Nodes', 'Connect another machine or manage saved libraries.', function (pane) {
        if (window.StreamNodes) return window.StreamNodes.settings(pane);
        node('p', 'Library connections could not load. Reload the page to try again.', pane);
      });
    }
    if (config.isAdmin) {
      advanced(tools, 'Library tools', 'Storage, background work, backups and moved files.', function (pane) {
        if (window.StreamLibraryTools?.maintenance) return window.StreamLibraryTools.maintenance(pane);
        node('p', 'Library tools could not load. Reload the page to try again.', pane);
      });
      advanced(tools, 'History', 'Review recently recorded viewing activity.', function (pane) {
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
      });
    } else {
      node('p', 'Sign in as the owner to manage access, library activity and backups.', body, 'settings-guest-note');
    }
    var loaded = false, loading = false;
    async function hydrate() {
      if (!config.isAdmin || loading || loaded) return;
      loading = true; retry.hidden = true;
      try {
        var data = await api('/api/settings', undefined, current);
        if (!current.open || current !== dialog) return;
        loaded = true;
        tracking.checked = data.tracking !== false; tracking.disabled = false;
        window.StreamActivity?.setEnabled(data.tracking !== false);
        lock.checked = Boolean(data.security?.requireLogin); lock.disabled = false;
        account.textContent = data.security?.username ? 'Signed in as ' + data.security.username : data.security?.mode || 'Owner account';
        loadNote.textContent = 'History stays with this server, across devices and updates.';
      } catch (error) {
        if (error.name !== 'AbortError') {
          loadNote.textContent = 'Library settings could not load. Your browser controls still work.';
          account.textContent = 'Account settings unavailable.';
          retry.hidden = false;
          message(error.message, true, current);
        }
      } finally { loading = false; }
    }
    current._resume = function () { if (config.isAdmin) void hydrate(); };
    if (config.isAdmin) await hydrate();
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
    if (dialog?.open) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stepBack(); }
      return;
    }
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input,textarea,select,[contenteditable="true"]')) {
      event.preventDefault(); event.stopImmediatePropagation(); void open();
    }
  }, true);
  window.StreamSettings = { open: function () { void open().catch(function (error) { message(error.message, true); }); }, preference: preference, init: function (value) { adapter = value; } };
})();
