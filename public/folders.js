(function () {
  'use strict';
  var config = JSON.parse(document.getElementById('app').dataset.config || '{}');
  var folders = [], selected = '', trigger, panel, label, host, pendingAction, tabbing = false;
  var storageKey = 'stream-folder-' + (config.node?.id || 'local');
  try { selected = localStorage.getItem(storageKey) || ''; } catch (_) {}

  function element(tag, text, parent, className) {
    var value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    if (parent) parent.appendChild(value);
    return value;
  }
  async function request(body) {
    var response = await fetch('/api/folders', body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    var data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not load folders.');
    return data;
  }
  function notify(initial) {
    window.dispatchEvent(new CustomEvent('stream:folder-change', { detail: {
      id: selected, configured: folders.length > 0, initial: Boolean(initial)
    } }));
  }
  function paint() {
    if (!trigger) return;
    var current = folders.find(function (folder) { return folder.id === selected; });
    label.textContent = current ? current.name : config.title || 'Stream';
    trigger.setAttribute('aria-label', 'Choose media folder: ' + (current ? current.name : 'All media'));
    panel.replaceChildren();
    element('p', 'YOUR FOLDERS', panel, 'folder-menu-eyebrow');
    var list = element('div', undefined, panel, 'folder-menu-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Media folders');
    function option(id, name) {
      var button = element('button', name, list, 'folder-option'); button.type = 'button';
      button.setAttribute('aria-pressed', String(selected === id));
      button.onclick = function () { close(function () { select(id); }); };
    }
    option('', 'All media');
    folders.forEach(function (folder) { option(folder.id, folder.name); });
    if (!folders.length) element('p', config.isAdmin ? 'Choose the folders you want here. Nested folders are included.' : 'No folder shortcuts have been configured.', panel, 'folder-menu-note');
    if (config.isAdmin) {
      var manage = element('button', 'Choose folders…', panel, 'folder-manage'); manage.type = 'button';
      manage.onclick = function () { close(function () { window.StreamSettings?.open('folders'); }); };
    }
  }
  function update(data, initial, changed) {
    folders = Array.isArray(data.folders) ? data.folders : [];
    var old = selected;
    if (selected && !folders.some(function (folder) { return folder.id === selected; })) selected = '';
    try { localStorage.setItem(storageKey, selected); } catch (_) {}
    paint();
    if (initial || old !== selected || changed) notify(initial);
  }
  function select(id) {
    if (id && !folders.some(function (folder) { return folder.id === id; })) return;
    selected = id;
    try { localStorage.setItem(storageKey, id); } catch (_) {}
    paint(); notify(false);
  }
  function hide() {
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outsideClick, true);
    var action = pendingAction; pendingAction = null;
    if (action) queueMicrotask(action); else trigger.focus({ preventScroll: true });
  }
  function close(action) {
    pendingAction = action || null;
    if (window.StreamNavigation?.has('folders')) window.StreamNavigation.leave('folders');
    else hide();
  }
  function show() {
    paint(); panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', outsideClick, true);
    panel.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }
  function open() {
    if (!panel.hidden) { close(); return; }
    if (window.StreamNavigation && !window.StreamNavigation.enter('folders', { back: hide, forward: show })) return;
    show();
  }
  function outsideClick(event) {
    if (host.contains(event.target)) return;
    var next = event.target.closest('button');
    if (!next || !next.closest('.header')) next = null;
    event.preventDefault(); event.stopImmediatePropagation();
    close(next ? function () { if (next.isConnected) { next.focus({ preventScroll: true }); next.click(); } } : null);
  }
  function mount(title) {
    host = title; host.classList.add('folder-switcher'); host.replaceChildren();
    trigger = element('button', undefined, host, 'folder-trigger'); trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', 'folder-menu');
    label = element('span', config.title || 'Stream', trigger, 'folder-trigger-label');
    element('span', '⌄', trigger, 'folder-trigger-arrow').setAttribute('aria-hidden', 'true');
    panel = element('section', undefined, host, 'folder-menu'); panel.id = 'folder-menu'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Choose media folder');
    trigger.onclick = open;
    host.addEventListener('keydown', function (event) {
      if (panel.hidden) return;
      tabbing = event.key === 'Tab';
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        var buttons = Array.from(panel.querySelectorAll('button'));
        var index = buttons.indexOf(document.activeElement);
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = buttons.length - 1;
        else index = (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[index]?.focus();
      }
    });
    host.addEventListener('focusout', function () {
      if (!tabbing) return;
      tabbing = false;
      queueMicrotask(function () {
        var next = document.activeElement;
        if (!panel.hidden && !host.contains(next)) close(function () { next?.focus({ preventScroll: true }); });
      });
    });
    paint();
    return request().then(function (data) { update(data, true); }).catch(function () {
      // A failed shortcut request must never make the gallery unavailable.
      selected = ''; notify(true);
      panel.replaceChildren(); element('p', 'Folder shortcuts could not load. Reload to try again.', panel, 'folder-menu-note');
    });
  }

  async function settings(pane) {
    var status = element('p', 'Loading folders…', pane, 'settings-footnote'); status.setAttribute('role', 'status');
    var data;
    try { data = await request(); } catch (error) { status.textContent = error.message; return; }
    if (!pane.isConnected) return;
    status.textContent = 'Name a folder and enter its path inside your mounted media folder. All nested folders are included.';
    element('p', 'Example: name “Anime”, path “Entertainment/Anime”. These are shortcuts, not separate passwords or sharing rules.', pane, 'settings-footnote');
    var list = element('div', undefined, pane, 'folder-edit-list');
    var rows = [];
    function row(folder) {
      var wrap = element('div', undefined, list, 'folder-edit-row');
      var nameLabel = element('label', 'Menu name', wrap);
      var name = element('input', undefined, nameLabel); name.value = folder.name || ''; name.maxLength = 80;
      name.placeholder = 'Anime'; name.setAttribute('aria-label', 'Folder menu name');
      var pathLabel = element('label', 'Folder inside media', wrap);
      var path = element('input', undefined, pathLabel); path.value = folder.path || ''; path.maxLength = 1024;
      path.placeholder = 'Entertainment/Anime'; path.setAttribute('aria-label', 'Folder path inside media');
      var remove = element('button', 'Remove', wrap, 'settings-small-button'); remove.type = 'button';
      var entry = { id: folder.id, name: name, path: path, wrap: wrap }; rows.push(entry);
      remove.onclick = function () { rows = rows.filter(function (value) { return value !== entry; }); wrap.remove(); };
      return name;
    }
    data.folders.forEach(row);
    var actions = element('div', undefined, pane, 'folder-edit-actions');
    var add = element('button', 'Add folder', actions, 'settings-small-button'); add.type = 'button';
    add.onclick = function () { row({}).focus(); };
    var save = element('button', 'Save folder menu', actions, 'settings-small-button'); save.type = 'button';
    save.onclick = async function () {
      var submitted = rows.slice();
      var controls = Array.from(pane.querySelectorAll('input,button')).map(function (control) {
        var state = { control: control, disabled: control.disabled }; control.disabled = true; return state;
      });
      status.textContent = 'Saving folders…';
      try {
        var result = await request({ folders: submitted.map(function (entry) {
          var folder = { name: entry.name.value.trim(), path: entry.path.value.trim() };
          if (entry.id) folder.id = entry.id;
          return folder;
        }) });
        result.folders.forEach(function (folder, index) { submitted[index].id = folder.id; });
        update(result, false, true);
        if (pane.isConnected) status.textContent = 'Folder menu saved. Media, history and existing sharing rules are unchanged.';
      } catch (error) { if (pane.isConnected) status.textContent = error.message; }
      finally { controls.forEach(function (state) { state.control.disabled = state.disabled; }); }
    };
    element('p', 'Removing a shortcut does not delete any files. Use the row order to set the menu order; new folders are added at the end.', pane, 'settings-footnote');
  }
  window.StreamFolders = { mount: mount, settings: settings, selected: function () { return selected; }, configured: function () { return folders.length > 0; } };
})();
