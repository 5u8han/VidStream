(function () {
  'use strict';
  var app = document.getElementById('app');
  if (!app) return;
  var config = JSON.parse(app.dataset.config || '{}');
  var snapshot = null, subscribers = new Set();
  var homeKey = 'stream-node-home', returnKey = 'stream-node-return';
  var home = '', confirmedHome = '', homeConfirmed = false;
  var fetches = new Set();

  function rootAddress(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020]/.test(value)) return null;
    try {
      var url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) return null;
      return url.origin;
    } catch (_) { return null; }
  }
  function saveHome(value) {
    home = rootAddress(value) || '';
    confirmedHome = home; homeConfirmed = Boolean(home);
    try {
      if (home) localStorage.setItem(homeKey, JSON.stringify({ url: home, confirmed: true }));
      else localStorage.removeItem(homeKey);
    } catch (_) {}
    try { sessionStorage.removeItem(returnKey); } catch (_) {}
  }
  try {
    var previous = localStorage.getItem(homeKey), record = null;
    try { record = JSON.parse(previous || 'null'); } catch (_) {}
    var remembered = record && record.confirmed === true ? rootAddress(record.url) : null;
    if (remembered) { confirmedHome = remembered; home = remembered; homeConfirmed = true; }
    else if (previous) localStorage.removeItem(homeKey);
  } catch (_) {}
  try {
    var sessionReturn = rootAddress(sessionStorage.getItem(returnKey));
    if (sessionReturn) { home = sessionReturn; homeConfirmed = sessionReturn === confirmedHome; }
  } catch (_) {}
  if (location.hash.startsWith('#vidstream-home=')) {
    var incoming = null;
    try {
      var parameters = new URLSearchParams(location.hash.slice(1));
      if (Array.from(parameters.keys()).length === 1) incoming = rootAddress(parameters.get('vidstream-home'));
    } catch (_) {}
    if (incoming) {
      home = incoming; homeConfirmed = incoming === confirmedHome;
      try { sessionStorage.setItem(returnKey, incoming); } catch (_) {}
    }
    history.replaceState(history.state, '', location.pathname + location.search);
  }
  function destination(value) {
    var origin = rootAddress(value);
    if (!origin) return null;
    var target = new URL(origin);
    target.hash = 'vidstream-home=' + encodeURIComponent(home || location.origin);
    return target.href;
  }
  function text(tag, value, parent, className) {
    var node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = value;
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }
  function action(label, parent, handler, className) {
    var button = text('button', label, parent, className || 'node-button');
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }
  function notify() { subscribers.forEach(function (fn) { fn(snapshot); }); }
  function accept(value) {
    if (!value || !value.self || !Array.isArray(value.peers) || !Array.isArray(value.nearby)) throw Error('Invalid library directory response');
    snapshot = value; notify(); return value;
  }
  async function api(path, body, owner) {
    var controller = new AbortController();
    fetches.add(controller);
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    var dialog = owner && owner.closest('dialog');
    function closed() { if (!dialog.open) controller.abort(); }
    if (dialog) dialog.addEventListener('close', closed);
    try {
      var response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      var result = await response.json();
      if (!response.ok) throw Error(result.error || 'Could not contact this library');
      return result;
    } finally {
      clearTimeout(timeout); fetches.delete(controller);
      if (dialog) dialog.removeEventListener('close', closed);
    }
  }
  function returnLink(parent, className) {
    if (!home || home === location.origin) return null;
    var link = text('a', null, parent, className || 'node-return');
    link.href = home + '/'; link.rel = 'noopener';
    link.setAttribute('aria-label', homeConfirmed ? 'Return to starting library' : 'Return to linked library');
    text('span', homeConfirmed ? '← Starting library' : '← Return to library', link);
    text('small', new URL(home).host, link);
    if (!homeConfirmed) text('small', 'From navigation link', link, 'node-return-hint');
    return link;
  }
  function currentName() { return snapshot?.self.name || config.node?.name || config.title || 'This library'; }
  function connectionState(peer) {
    if (peer.status === 'identity-changed') return { blocked: true, label: 'Identity changed · review connection', className: 'is-changed' };
    if (peer.online === true) return { label: 'Online', className: 'is-online' };
    if (peer.online === false) return { label: 'Offline · open anyway', className: 'is-offline' };
    return { label: 'Not checked · open anyway', className: 'is-unchecked' };
  }

  function mount(header) {
    if (!header || header.querySelector('.node-switcher')) return;
    header.classList.add('has-node-switcher');
    var wrap = text('div', null, header, 'node-switcher');
    var trigger = action('', wrap, function () { window.StreamSettings.open('nodes', trigger); }, 'node-trigger');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'stream-settings');
    trigger.setAttribute('aria-expanded', 'false');
    text('span', 'Node', trigger, 'node-kind');
    var label = text('strong', currentName(), trigger, 'node-trigger-label');
    text('span', '⌄', trigger, 'node-trigger-arrow').setAttribute('aria-hidden', 'true');
    function render() {
      label.textContent = currentName();
      trigger.setAttribute('aria-label', 'Switch node · ' + currentName());
    }
    render();
    subscribers.add(render);
  }

  function mountLocked(parent) {
    if (!parent || parent.querySelector('.node-locked-return')) return;
    if (returnLink(parent, 'node-locked-return')) parent.classList.add('has-node-return');
  }

  async function settings(pane) {
    if (!pane || !config.isAdmin) return;
    pane.replaceChildren(); pane.classList.add('node-settings');
    var dialog = pane.closest('dialog'), initialized = false, poll = null;
    function alive() { return pane.isConnected && (!dialog || dialog.open); }
    var status = text('p', 'Loading library connections…', pane, 'node-status');
    status.setAttribute('role', 'status');
    function message(value, error) { if (!alive()) return; status.textContent = value; status.classList.toggle('is-error', Boolean(error)); }
    async function run(button, operation) {
      if (button.disabled) return;
      button.disabled = true;
      try { await operation(); }
      catch (error) { if (error.name !== 'AbortError') message(error.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
    }
    text('p', 'Each machine keeps its own media, history and sign-in. Switching opens that machine directly; files are not uploaded, copied or combined.', pane, 'node-help');
    var selfSection = text('section', null, pane, 'node-settings-section');
    text('h3', 'This library', selfSection);
    var selfForm = text('form', null, selfSection, 'node-form');
    function field(label, parent, type) {
      var wrap = text('label', label, parent, 'node-field');
      var input = text('input', null, wrap); input.type = type || 'text'; input.setAttribute('aria-label', label);
      return input;
    }
    var name = field('Library name', selfForm); name.maxLength = 80; name.required = true;
    var roleLabel = text('label', 'Machine role', selfForm, 'node-field');
    var role = text('select', null, roleLabel);
    text('option', 'Server', role).value = 'server';
    text('option', 'Node', role).value = 'node';
    text('p', 'A server can add other machines to its switcher. A node serves its existing library and can still be opened from another machine.', selfForm, 'node-help');
    var address = field('This library address', selfForm, 'url'); address.placeholder = 'http://192.168.1.50'; address.autocomplete = 'url';
    text('p', 'Use the address other devices can open, including the published port. A container-only address or localhost will not work from your phone.', selfForm, 'node-help');
    var discoveryLabel = text('label', null, selfForm, 'node-check');
    var discovery = text('input', null, discoveryLabel); discovery.type = 'checkbox'; discovery.setAttribute('aria-label', 'Find nearby libraries');
    text('span', 'Find nearby libraries', discoveryLabel);
    text('p', 'Optional local-network discovery sends a small name/identity announcement. It never shares media, passwords or settings. Docker and routed networks may block discovery; manual addresses remain available.', selfForm, 'node-help');
    var save = text('button', 'Save library settings', selfForm, 'node-button'); save.type = 'submit';
    save.disabled = true;
    var discoveryStatus = text('p', '', selfSection, 'node-help');
    var identity = text('small', '', selfSection, 'node-identity');
    selfForm.addEventListener('submit', function (event) {
      event.preventDefault();
      void run(save, async function () {
        var url = address.value.trim();
        if (url && !rootAddress(url)) throw Error('Enter a complete http:// or https:// address without a path, password, query or fragment.');
        var data = await api('/api/nodes/settings', { name: name.value.trim(), url: url, discoveryEnabled: discovery.checked, role: role.value }, pane);
        if (!alive()) return;
        accept(data);
        dialog?.dispatchEvent(new CustomEvent('stream:node-role', { detail: data.self.role }));
        message('Library settings saved.');
      });
    });
    var manual = text('section', null, pane, 'node-settings-section');
    manual.hidden = true;
    text('h3', 'Add another machine', manual);
    var addForm = text('form', null, manual, 'node-form');
    var otherAddress = field('Other library address', addForm, 'url'); otherAddress.required = true; otherAddress.placeholder = 'http://192.168.1.60'; otherAddress.autocomplete = 'url';
    var check = text('button', 'Check library', addForm, 'node-button'); check.type = 'submit';
    var verifiedBox = text('div', null, manual, 'node-verified'); verifiedBox.hidden = true;
    var checkGeneration = 0;
    otherAddress.addEventListener('input', function () { checkGeneration++; verifiedBox.hidden = true; verifiedBox.replaceChildren(); });
    async function checkPeer(value) {
      var generation = ++checkGeneration;
      verifiedBox.hidden = true; verifiedBox.replaceChildren();
      var url = rootAddress(value);
      if (!url) throw Error('Enter a complete http:// or https:// address without a path, password, query or fragment.');
      message('Checking this library address…');
      var result = await api('/api/nodes/probe', { url: url }, pane);
      if (!alive() || generation !== checkGeneration) return;
      var peer = result.peer;
      if (!peer || !rootAddress(peer.url) || typeof peer.id !== 'string') throw Error('Invalid library identity response');
      verifiedBox.hidden = false;
      text('strong', peer.name, verifiedBox);
      text('span', peer.url, verifiedBox, 'node-address');
      text('small', 'Library identity: ' + peer.id, verifiedBox, 'node-identity');
      text('p', 'Check that the address and name belong to the machine you expect. Adding it saves a connection only. Sign in on that machine when you open it.', verifiedBox, 'node-help');
      var existing = (snapshot?.peers || []).find(function (entry) { return entry.id === peer.id; });
      var changingAddress = Boolean(existing && existing.url !== peer.url);
      if (changingAddress) text('p', 'This is the same library at a new address. Its saved address is ' + existing.url + '.', verifiedBox, 'node-help');
      action(changingAddress ? 'Update saved address' : 'Add to switcher', verifiedBox, function (event) {
        void run(event.currentTarget, async function () {
          var data = await api('/api/nodes/add', { url: peer.url, expectedId: peer.id, replaceAddress: changingAddress }, pane);
          if (!alive()) return;
          accept(data); verifiedBox.hidden = true; verifiedBox.replaceChildren(); otherAddress.value = '';
          message(changingAddress ? 'Saved address updated.' : 'Library added to the switcher.');
        });
      });
      message('Library found. Review it before adding.');
    }
    addForm.addEventListener('submit', function (event) { event.preventDefault(); void run(check, function () { return checkPeer(otherAddress.value.trim()); }); });
    var savedSection = text('section', null, pane, 'node-settings-section');
    pane.prepend(savedSection);
    text('h3', 'Switch node', savedSection);
    var homeRow = text('div', null, savedSection, 'node-home-actions');
    function paintHome() {
      homeRow.replaceChildren();
      returnLink(homeRow);
      if (home && home !== location.origin && !homeConfirmed) action('Remember return address', homeRow, function () { saveHome(home); paintHome(); });
      if (home !== location.origin || !homeConfirmed) action('Set this as my starting node', homeRow, function () { saveHome(location.origin); paintHome(); });
    }
    paintHome();
    text('p', 'Removing a connection keeps all media and data on both machines. Offline libraries stay saved.', savedSection, 'node-help');
    var savedList = text('div', null, savedSection, 'node-peer-list');
    var refresh = action('Refresh library status', savedSection, function () {
      void run(refresh, async function () {
        accept(await api('/api/nodes/refresh', {}, pane));
        if (!alive()) return;
        message('Checking saved library status…');
        var attempts = 0;
        clearTimeout(poll);
        async function update() {
          if (!alive() || pane.hidden || document.hidden) return;
          try {
            var data = await api('/api/nodes', undefined, pane);
            if (!alive()) return;
            accept(data);
            if (data.refreshing && ++attempts < 12) poll = setTimeout(update, 1000);
            else message(data.refreshing ? 'Some libraries are still being checked. Their saved connections are retained.' : 'Library status updated.');
          } catch (error) { if (error.name !== 'AbortError') message(error.message, true); }
        }
        poll = setTimeout(update, 800);
      });
    });
    var nearbySection = text('section', null, pane, 'node-settings-section');
    nearbySection.hidden = true;
    text('h3', 'Nearby libraries', nearbySection);
    text('p', 'Nearby announcements are unverified hints. Check a machine before saving it; discovery never automatically joins a library.', nearbySection, 'node-help');
    var nearbyList = text('div', null, nearbySection, 'node-peer-list');
    function render(data) {
      if (!pane.isConnected) { subscribers.delete(render); clearTimeout(poll); return; }
      if (!alive() || !data) return;
      var canAdd = data.self.role !== 'node';
      if (!initialized) {
        name.value = data.self.name || currentName(); address.value = data.self.url || '';
        discovery.checked = Boolean(data.self.discoveryEnabled); role.value = canAdd ? 'server' : 'node';
        save.disabled = false; initialized = true;
      }
      manual.hidden = nearbySection.hidden = !canAdd;
      if (!canAdd) { checkGeneration++; verifiedBox.hidden = true; verifiedBox.replaceChildren(); }
      discoveryStatus.textContent = data.discovery?.error ? 'Discovery unavailable: ' + data.discovery.error : data.discovery?.active ? 'Nearby discovery is active on this network.' : data.self.discoveryEnabled ? 'Discovery is enabled but not active. Check the library address and network.' : 'Nearby discovery is off.';
      identity.textContent = 'This library identity: ' + data.self.id;
      savedList.replaceChildren();
      if (!data.peers.length) text('p', 'No other libraries saved yet.', savedList, 'node-help');
      data.peers.forEach(function (peer) {
        var state = connectionState(peer);
        var row = text('article', null, savedList, 'node-peer');
        var info = text('div', null, row, 'node-peer-info');
        text('strong', peer.name, info); text('small', peer.url, info, 'node-address');
        text('span', state.label, info, 'node-state ' + state.className);
        if (state.blocked) text('small', 'This address now identifies a different library. Remove this connection, then check the address again before adding its replacement.', info, 'node-help');
        var href = destination(peer.url);
        if (href && !state.blocked) { var link = text('a', 'Open', row, 'node-button'); link.href = href; link.rel = 'noopener'; link.setAttribute('aria-label', 'Open ' + peer.name); }
        var remove = action('Remove', row, function () {
          void run(remove, async function () {
            var updated = await api('/api/nodes/remove', { id: peer.id }, pane);
            if (!alive()) return;
            accept(updated); message('Connection removed. Media and data remain on both machines.');
          });
        }, 'node-button node-remove');
        remove.setAttribute('aria-label', 'Remove ' + peer.name);
      });
      nearbyList.replaceChildren();
      if (!data.nearby.length) text('p', 'No nearby libraries detected. You can always enter an address manually.', nearbyList, 'node-help');
      data.nearby.forEach(function (peer) {
        var row = text('article', null, nearbyList, 'node-peer');
        var info = text('div', null, row, 'node-peer-info');
        text('strong', peer.name, info); text('small', peer.url, info, 'node-address');
        text('span', 'Unverified nearby library', info, 'node-state');
        var candidate = rootAddress(peer.url);
        var parsed = candidate && new URL(candidate);
        if (parsed && parsed.protocol === 'https:' && (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname.startsWith('['))) {
          text('small', 'HTTPS requires the hostname on its certificate. Enter that hostname under Other library address.', info, 'node-help');
          action('Enter certificate hostname', row, function () {
            checkGeneration++; verifiedBox.hidden = true; verifiedBox.replaceChildren();
            otherAddress.value = 'https://'; otherAddress.focus();
            otherAddress.scrollIntoView({ block: 'center' });
            message('Enter this machine’s certificate hostname and published port, then choose Check library.');
          });
        }
        var button = action('Check library', row, function () {
          otherAddress.value = peer.url;
          void run(button, function () { return checkPeer(peer.url); });
        });
        button.setAttribute('aria-label', 'Check nearby ' + peer.name);
      });
    }
    subscribers.add(render);
    function closed() {
      if (dialog.open) return;
      clearTimeout(poll);
      dialog.removeEventListener('close', closed);
    }
    if (dialog) dialog.addEventListener('close', closed);
    try {
      var data = await api('/api/nodes', undefined, pane);
      if (!alive()) return;
      accept(data); message('Connections stay on this server. Each destination controls its own access.');
    } catch (error) { if (error.name !== 'AbortError') message(error.message, true); }
  }

  window.addEventListener('pagehide', function () { fetches.forEach(function (controller) { controller.abort(); }); fetches.clear(); });
  window.StreamNodes = { mount: mount, mountLocked: mountLocked, settings: settings };
})();
