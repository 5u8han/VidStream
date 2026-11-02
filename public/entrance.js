(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.StreamEntrance = api.install(root);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  // Browser-profile state, deliberately separate from synced view preferences
  // and media activity. No device fingerprint, account record or server call.
  function createState(storage) {
    var memory = Object.create(null), unavailable = !storage;
    var prefix = 'stream-entrance-v1:';
    function read(name) {
      if (!unavailable) {
        try { memory[name] = storage.getItem(prefix + name); return memory[name]; }
        catch (_) { unavailable = true; }
      }
      return memory[name] || null;
    }
    function write(name, value) {
      memory[name] = value;
      if (!unavailable) {
        try {
          if (value === null) storage.removeItem(prefix + name);
          else storage.setItem(prefix + name, value);
        } catch (_) { unavailable = true; }
      }
    }
    return {
      needsWelcome: function () { return read('welcome') !== '1'; },
      welcomeSeen: function () { write('welcome', '1'); },
      needsGallery: function () { return read('gallery') !== '1'; },
      gallerySeen: function () { write('gallery', '1'); },
      // Call only after the server confirms login or owner setup, before reload.
      signedIn: function () { write('welcome', null); write('gallery', null); },
    };
  }

  function install(win) {
    var doc = win.document, storage = null;
    try { storage = win.localStorage; } catch (_) { /* privacy settings */ }
    var state = createState(storage);
    var reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    var running = new Map(), welcome = null, dismissWelcome = null;
    function saved(key) {
      try { return storage && storage.getItem(key); } catch (_) { return null; }
    }
    function motionAllowed() {
      return !reduced.matches && saved('stream-data-saver') !== '1' &&
        (doc.documentElement.dataset.effects || saved('stream-effects') || 'full') === 'full';
    }
    function finish(node) {
      var entry = running.get(node);
      if (!entry) return;
      win.clearTimeout(entry.timer);
      node.removeEventListener('animationend', entry.end);
      node.removeEventListener('animationcancel', entry.end);
      node.classList.remove(entry.name);
      node.style.removeProperty('--entrance-delay');
      running.delete(node);
    }
    function reveal(node, name, delay) {
      if (!node || !motionAllowed()) return;
      finish(node);
      var entry = { name: name };
      entry.end = function (event) { if (event.target === node) finish(node); };
      node.addEventListener('animationend', entry.end);
      node.addEventListener('animationcancel', entry.end);
      node.style.setProperty('--entrance-delay', (delay || 0) + 'ms');
      running.set(node, entry);
      node.classList.add(name);
      // Also clean up when a hidden/removed element never emits animationend.
      entry.timer = win.setTimeout(function () { finish(node); }, 850);
    }
    function cancel() { Array.from(running.keys()).forEach(finish); }
    reduced.addEventListener('change', function () { if (reduced.matches) cancel(); });
    win.addEventListener('pagehide', cancel);

    function text(tag, value, className) {
      var node = doc.createElement(tag);
      if (value) node.textContent = value;
      if (className) node.className = className;
      return node;
    }
    function showWelcome(parent) {
      if (!state.needsWelcome() || welcome) return;
      state.welcomeSeen();
      welcome = text('aside', null, 'entrance-welcome');
      welcome.setAttribute('aria-label', 'Welcome');
      var mark = text('span', null, 'entrance-mark');
      mark.setAttribute('aria-hidden', 'true');
      var content = doc.createElement('div');
      content.appendChild(text('p', 'Your media · Your machine', 'entrance-eyebrow'));
      content.appendChild(text('h2', 'Welcome to your stream', 'entrance-title'));
      content.appendChild(text('p', 'A fast, private view of your local library. Make yourself at home.', 'entrance-copy'));
      var close = text('button', '×', 'entrance-dismiss');
      close.type = 'button'; close.setAttribute('aria-label', 'Dismiss welcome');
      dismissWelcome = function () {
        if (!welcome) return;
        var focused = doc.activeElement === close;
        finish(welcome); welcome.remove(); welcome = null;
        if (focused) doc.querySelector('.header button')?.focus({ preventScroll: true });
      };
      close.addEventListener('click', dismissWelcome);
      welcome.append(mark, content, close);
      parent.appendChild(welcome);
      reveal(welcome, 'entrance-welcome-reveal');
    }

    return {
      state: state,
      cancel: cancel,
      shell: function (header) { if (state.needsWelcome()) reveal(header, 'entrance-shell'); },
      signIn: function (card) {
        if (!state.needsWelcome()) return;
        state.welcomeSeen();
        reveal(card, 'entrance-card');
      },
      welcome: showWelcome,
      dismissWelcome: function () { if (dismissWelcome) dismissWelcome(); },
      gallery: function (grid, skipAnimation) {
        if (!state.needsGallery() || !grid.querySelector('.tile')) return;
        state.gallerySeen();
        if (skipAnimation || !motionAllowed()) return;
        // One bounded geometry read phase, then writes. Never animate a whole
        // catalog or create a scroll observer/ongoing animation loop.
        var visible = Array.from(grid.querySelectorAll('.tile')).slice(0, 36).filter(function (tile) {
          var rect = tile.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < win.innerHeight;
        }).slice(0, 18);
        visible.forEach(function (tile, index) { reveal(tile, 'entrance-tile', Math.min(index * 20, 240)); });
      },
      loading: function (status) {
        status.replaceChildren();
        var first = state.needsGallery();
        status.classList.toggle('entrance-loading', first);
        if (first) {
          var mark = text('span', null, 'entrance-loading-mark');
          mark.setAttribute('aria-hidden', 'true');
          // CSS handles live reduced-motion/effects changes, including loading.
          if (!motionAllowed()) mark.style.animation = 'none';
          status.append(mark, text('span', 'Opening your library…', 'entrance-loading-copy'));
        } else status.textContent = 'Loading…';
      },
      loaded: function (status) { status.classList.remove('entrance-loading'); status.replaceChildren(); },
    };
  }
  return { createState: createState, install: install };
});
