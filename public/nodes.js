(function () {
  'use strict';
  var app = document.getElementById('app');
  if (!app) return;
  var config = JSON.parse(app.dataset.config || '{}');
  var snapshot = null, lastError = '', loading = null, subscribers = new Set();
  var homeKey = 'stream-node-home', returnKey = 'stream-node-return';
  var home = '', confirmedHome = '', homeConfirmed = false;
  var fetches = new Set();

  // A navigation fragment is an unverified return hint, retained only in this
  // tab's session through sign-in. Persistence requires a separate user action.
  // It never adds a peer, probes a server, grants access, or transports accounts.
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
    else if (previous) localStorage.removeItem(homeKey); // discard pre-release unconfirmed records
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
    snapshot = value; lastError = ''; notify(); return value;
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
  async function readDirectory() {
    if (!config.isAdmin) return null;
    if (loading) return loading;
    loading = api('/api/nodes').then(accept).catch(function (error) {
      if (error.name !== 'AbortError') { lastError = error.message; notify(); }
      return null;
    }).finally(function () { loading = null; });
    return loading;
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
    var trigger = action('', wrap, toggle, 'node-trigger');
    trigger.setAttribute('aria-label', 'Switch library');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'node-library-list');
    var dot = text('span', '●', trigger, 'node-presence'); dot.setAttribute('aria-hidden', 'true');
    var label = text('span', currentName(), trigger, 'node-trigger-label');
    var arrow = text('span', '⌄', trigger, 'node-trigger-arrow'); arrow.setAttribute('aria-hidden', 'true');
    var panel = text('nav', null, wrap, 'node-popover');
    panel.id = 'node-library-list'; panel.setAttribute('aria-label', 'Libraries');
    panel.hidden = true; panel.inert = true;
    var afterClose = null, timer = null;
    function close() {
      panel.hidden = true; panel.inert = true; trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', outside, true);
      document.removeEventListener('keydown', keydown, true);
      trigger.focus({ preventScroll: true });
      if (afterClose) { var next = afterClose; afterClose = null; setTimeout(next, 0); }
    }
    function back() { if (window.StreamNavigation?.has('nodes')) window.StreamNavigation.back(); else close(); }
    function show() {
      if (!wrap.isConnected) return false;
      panel.hidden = false; panel.inert = false; trigger.setAttribute('aria-expanded', 'true');
      panel.style.setProperty('--nodes-top', Math.max(8, header.getBoundingClientRect().bottom + 6) + 'px');
      document.addEventListener('click', outside, true);
      document.addEventListener('keydown', keydown, true);
      render(); panel.querySelector('a,button')?.focus({ preventScroll: true });
      void readDirectory();
    }
    function toggle(event) {
      event.stopPropagation();
      if (!panel.hidden) return back();
      if (window.StreamNavigation && !window.StreamNavigation.enter('nodes', { back: close, forward: show })) return;
      show();
    }
    function outside(event) {
      if (wrap.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation(); back();
    }
    function keydown(event) {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation(); back();
      }
    }
    function render() {
      if (!wrap.isConnected) { subscribers.delete(render); clearInterval(timer); return; }
      label.textContent = currentName(); trigger.title = 'Switch library · ' + currentName();
      if (panel.hidden) return;
      var focused = panel.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') || document.activeElement.textContent : null;
      panel.replaceChildren();
      text('p', 'LIBRARIES', panel, 'node-eyebrow');
      var current = text('div', null, panel, 'node-menu-current');
      current.setAttribute('aria-current', 'page');
      text('strong', currentName(), current);
      text('small', 'This library · ' + location.host, current);
      var peers = snapshot?.peers || [];
      peers.forEach(function (peer) {
        var href = destination(peer.url);
        if (!href || peer.id === snapshot?.self.id) return;
        var state = connectionState(peer);
        var link = text(state.blocked ? 'div' : 'a', null, panel, 'node-menu-link' + (state.blocked ? ' is-blocked' : ''));
        if (state.blocked) link.setAttribute('aria-disabled', 'true');
        else { link.href = href; link.rel = 'noopener'; link.setAttribute('aria-label', 'Open ' + peer.name); }
        text('strong', peer.name, link);
        text('small', new URL(peer.url).host, link);
        text('span', state.label, link, 'node-state ' + state.className);
      });
      if (!peers.length && config.isAdmin) text('p', snapshot ? 'No other libraries saved yet.' : lastError || 'Loading your libraries…', panel, 'node-help');
      if (snapshot?.nearby.length) text('p', snapshot.nearby.length + ' nearby ' + (snapshot.nearby.length === 1 ? 'library' : 'libraries') + ' found. Review them in Settings → Nodes.', panel, 'node-help');
      returnLink(panel);
      if (config.isAdmin) {
        action('Refresh library status', panel, async function (event) {
          var button = event.currentTarget; button.disabled = true;
          try { accept(await api('/api/nodes/refresh', {})); setTimeout(function () { if (wrap.isConnected && !panel.hidden) void readDirectory(); }, 3500); }
          catch (error) { if (error.name !== 'AbortError') { lastError = error.message; render(); } }
          finally { if (button.isConnected) button.disabled = false; }
        });
        action('Manage libraries in Settings', panel, function () {
          afterClose = function () { window.StreamSettings?.open(); }; back();
        });
      } else text('p', 'Sign in to manage connected libraries.', panel, 'node-help');
      if (home && home !== location.origin && !homeConfirmed) action('Remember this return address', panel, function () {
        saveHome(home); render(); panel.querySelector('.node-return')?.focus({ preventScroll: true });
      });
      action('Make this my starting library', panel, function () { saveHome(location.origin); render(); });
      if (lastError && peers.length) text('p', lastError, panel, 'node-error');
      if (focused) Array.from(panel.querySelectorAll('a,button')).find(function (item) { return (item.getAttribute('aria-label') || item.textContent) === focused; })?.focus({ preventScroll: true });
    }
    subscribers.add(render);
    timer = setInterval(function () {
      if (!wrap.isConnected) { clearInterval(timer); subscribers.delete(render); return; }
      if (!document.hidden && config.isAdmin) void readDirectory();
    }, 60000);
    window.addEventListener('pagehide', function () { clearInterval(timer); }, { once: true });
    void readDirectory();
  }

  function mountLocked(parent) {
    if (!parent || parent.querySelector('.node-locked-return')) return;
    if (returnLink(parent, 'node-locked-return')) parent.classList.add('has-node-return');
  }

  async function settings(pane) {
    if (!pane) return;
    pane.replaceChildren(); pane.classList.add('node-settings');
    if (!config.isAdmin) {
      text('p', 'Owner sign-in required to manage nodes. Close Settings and choose Admin sign in.', pane, 'node-help');
      return;
    }
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
    var address = field('This library address', selfForm, 'url'); address.placeholder = 'http://192.168.1.50:4000'; address.autocomplete = 'url';
    text('p', 'Use the address other devices can open, including the published port. A container-only address or localhost will not work from your phone.', selfForm, 'node-help');
    var discoveryLabel = text('label', null, selfForm, 'node-check');
    var discovery = text('input', null, discoveryLabel); discovery.type = 'checkbox'; discovery.setAttribute('aria-label', 'Find nearby libraries');
    text('span', 'Find nearby libraries', discoveryLabel);
    text('p', 'Optional local-network discovery sends a small name/identity announcement. It never shares media, passwords or settings. Docker and routed networks may block discovery; manual addresses remain available.', selfForm, 'node-help');
    var save = text('button', 'Save library settings', selfForm, 'node-button'); save.type = 'submit';
    var discoveryStatus = text('p', '', selfSection, 'node-help');
    var identity = text('small', '', selfSection, 'node-identity');
    selfForm.addEventListener('submit', function (event) {
      event.preventDefault();
      void run(save, async function () {
        var url = address.value.trim();
        if (url && !rootAddress(url)) throw Error('Enter a complete http:// or https:// address without a path, password, query or fragment.');
        var data = await api('/api/nodes/settings', { name: name.value.trim(), url: url, discoveryEnabled: discovery.checked }, pane);
        if (!alive()) return;
        accept(data); message('Library settings saved.');
      });
    });
    var manual = text('section', null, pane, 'node-settings-section');
    text('h3', 'Add another machine', manual);
    var addForm = text('form', null, manual, 'node-form');
    var otherAddress = field('Other library address', addForm, 'url'); otherAddress.required = true; otherAddress.placeholder = 'http://192.168.1.60:4000'; otherAddress.autocomplete = 'url';
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
      action('Add to switcher', verifiedBox, function (event) {
        void run(event.currentTarget, async function () {
          var data = await api('/api/nodes/add', { url: peer.url, expectedId: peer.id }, pane);
          if (!alive()) return;
          accept(data); verifiedBox.hidden = true; verifiedBox.replaceChildren(); otherAddress.value = '';
          message('Library added to the switcher. No media was copied.');
        });
      });
      message('Library found. Review it before adding.');
    }
    addForm.addEventListener('submit', function (event) { event.preventDefault(); void run(check, function () { return checkPeer(otherAddress.value.trim()); }); });
    var savedSection = text('section', null, pane, 'node-settings-section');
    text('h3', 'Saved libraries', savedSection);
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
    text('h3', 'Nearby libraries', nearbySection);
    text('p', 'Nearby announcements are unverified hints. Check a machine before saving it; discovery never automatically joins a library.', nearbySection, 'node-help');
    var nearbyList = text('div', null, nearbySection, 'node-peer-list');
    function render(data) {
      if (!pane.isConnected) { subscribers.delete(render); clearTimeout(poll); return; }
      if (!alive() || !data) return;
      if (!initialized) { name.value = data.self.name || currentName(); address.value = data.self.url || ''; discovery.checked = Boolean(data.self.discoveryEnabled); initialized = true; }
      discoveryStatus.textContent = data.discovery?.error ? 'Discovery unavailable: ' + data.discovery.error + '. Manual addresses still work.' : data.discovery?.active ? 'Nearby discovery is active on this network.' : data.self.discoveryEnabled ? 'Discovery is enabled but not active. Check the library address and network.' : 'Nearby discovery is off. Add a machine by its address below.';
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
