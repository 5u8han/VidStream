(function () {
  'use strict';

  var appEl = document.getElementById('app');
  var CONFIG = JSON.parse(appEl.dataset.config || '{}');
  var INITIAL_ITEM = appEl.dataset.initial ? JSON.parse(appEl.dataset.initial) : null;

  var prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canHover = matchMedia('(hover: hover)').matches;
  // Per-visitor "lite mode" for anyone on constrained hardware/data --
  // separate from the server-wide VIDEO_AUTOPLAY_PREVIEWS setting, and
  // off by default so browsing stays full-featured for everyone else.
  // Applying it takes a reload (see the menu item below) rather than
  // live-recreating IntersectionObservers mid-session.
  var dataSaverMode = (function () { try { return localStorage.getItem('stream-data-saver') === '1'; } catch (e) { return false; } })();
  var autoplayEnabled = CONFIG.videoAutoplayPreviews && !prefersReducedMotion && !dataSaverMode;
  var isAdmin = Boolean(CONFIG.isAdmin);
  var libraryStatus = null; // last /api/library-status response (counts + unsupported/failed lists)

  // Ambient animated background (public/ambient.js). null = none: it's
  // skipped for reduced-motion and Data saver, and every use below checks.
  var bg = window.StreamAmbient
    ? window.StreamAmbient.start({ reducedMotion: prefersReducedMotion, lite: dataSaverMode })
    : null;

  // REQUIRE_LOGIN: signed-out visitors get nothing but a sign-in card.
  if (CONFIG.locked) {
    appEl.innerHTML = '';
    var lockedModal = buildSignInModal({ locked: true });
    appEl.appendChild(lockedModal.root);
    lockedModal.open();
    return;
  }

  var ICONS = {
    close: '<path d="M6 6L18 18M18 6L6 18"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.4M8.3 13.3l7.4 4.4"/>',
    download: '<path d="M12 3v11M7.5 10L12 14.5 16.5 10M5 19h14"/>',
    refresh: '<path d="M4 10a8 8 0 0114-5.3M20 5v5h-5M20 14a8 8 0 01-14 5.3M4 19v-5h5"/>',
    rss: '<circle cx="6.2" cy="17.8" r="1.6" fill="currentColor" stroke="none"/><path d="M4 10.5a9.5 9.5 0 019.5 9.5M4 4.8a15.2 15.2 0 0115.2 15.2"/>',
    sliders: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="14" cy="7" r="2" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="8" cy="12" r="2" fill="currentColor"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="16" cy="17" r="2" fill="currentColor"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0122 12s-1.1 2.2-3.2 4M6.5 6.7C3.7 8.6 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.7"/><path d="M9.5 9.6a3 3 0 004.1 4.2"/>',
    play: '<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>',
    pause: '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5" stroke-width="2.2"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
    edit: '<path d="M4 20l1-4.2L15.8 5 19 8.2 8.2 19 4 20z"/><path d="M13.2 6.6L17.4 10.8"/>',
    rotate: '<path d="M20 12a8 8 0 11-3-6.2"/><path d="M20 3v4h-4"/>',
    volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M17 8.5a5 5 0 010 7" />',
  };
  function icon(name, extraClass) {
    return '<svg class="' + (extraClass || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }

  function formatDuration(sec) {
    sec = Math.round(sec || 0);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function storageGet(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function storageSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore (private browsing etc.) */ }
  }

  // ---------------------------------------------------------------
  // Theme + density (data-theme/data-density already applied by the
  // inline boot script in <head> to avoid a flash; this just keeps
  // the menu UI and localStorage in sync with further changes).
  // ---------------------------------------------------------------

  var THEMES = [
    { id: 'system', label: 'System', swatch: null },
    { id: 'light-table', label: 'Light Table', swatch: '#a83831' },
    { id: 'darkroom', label: 'Darkroom', swatch: '#c1443c' },
    { id: 'golden-hour', label: 'Golden Hour', swatch: '#d68c33' },
    { id: 'contact-sheet', label: 'Contact Sheet', swatch: '#2f4c6b' },
  ];
  var DENSITIES = [
    { id: 'small', label: 'Small' },
    { id: 'medium', label: 'Medium' },
    { id: 'large', label: 'Large' },
  ];

  var currentTheme = storageGet('stream-theme', 'system');
  var currentDensity = storageGet('stream-density', 'medium');

  function applyTheme(theme) {
    currentTheme = theme;
    storageSet('stream-theme', theme);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }
  function applyDensity(density) {
    currentDensity = density;
    storageSet('stream-density', density);
    document.documentElement.setAttribute('data-density', density);
  }
  if (!document.documentElement.hasAttribute('data-density')) applyDensity(currentDensity);

  // Declared before the App shell section below because buildMenu()
  // (called synchronously from renderHeader()) reads state.sort while
  // marking the current selection -- it can't wait for the "Grid
  // state" section further down the file.
  var state = {
    type: null,
    album: null,
    has: null,
    q: '',
    sort: CONFIG.defaultReverseSort ? 'asc' : 'desc',
    seed: '',
    cursor: null,
    loading: false,
    done: false,
    loadedOnce: false,
    loadToken: 0,
  };

  var selection = { active: false, ids: new Set() };

  // ---------------------------------------------------------------
  // App shell
  // ---------------------------------------------------------------

  appEl.innerHTML = '';
  var header = el('header', { class: 'header' });
  var grid = el('ul', { class: 'grid', id: 'grid' });
  var main = el('main');
  main.appendChild(grid);
  var linksBottom = el('ul', { class: 'links-bottom' });
  var lightbox = buildLightbox();
  if (bg) lightbox.root.classList.add('ambient');
  var toastEl = el('div', { class: 'toast' });
  var signInModal = buildSignInModal();
  var selectionBar = buildSelectionBar();
  var librarySummary = buildLibrarySummary();
  var filesModal = buildFilesModal();

  appEl.appendChild(header);
  appEl.appendChild(main);
  appEl.appendChild(librarySummary.root);
  appEl.appendChild(linksBottom);
  appEl.appendChild(lightbox.root);
  appEl.appendChild(signInModal.root);
  appEl.appendChild(filesModal.root);
  appEl.appendChild(selectionBar.root);
  appEl.appendChild(toastEl);

  renderHeader();
  renderBottomLinks();
  if (window.StreamAmbient) {
    window.StreamAmbient.bindHoverFx(header);
    window.StreamAmbient.bindHoverFx(linksBottom);
  }

  // ---------------------------------------------------------------
  // Options menu (sort / contains / density / theme)
  // ---------------------------------------------------------------

  function buildMenu() {
    var wrap = el('div', { class: 'menu-wrap' });
    var trigger = el('button', { class: 'icon-btn', title: 'View options', 'aria-label': 'View options' }, icon('sliders'));
    var panel = el('div', { class: 'menu-panel' });

    function section(label) {
      var s = el('div', { class: 'menu-section' });
      s.appendChild(el('div', { class: 'menu-label' }, label));
      return s;
    }

    var sortSection = section('Sort');
    var sortOptions = [
      { id: 'desc', label: 'Newest first' },
      { id: 'asc', label: 'Oldest first' },
      { id: 'name-asc', label: 'Name A–Z' },
      { id: 'name-desc', label: 'Name Z–A' },
      { id: 'random', label: 'Shuffle' },
    ];
    sortOptions.forEach(function (opt) {
      var item = el('button', { class: 'menu-item', 'data-sort': opt.id }, '<span>' + opt.label + '</span>');
      item.addEventListener('click', function () {
        if (opt.id === 'random') state.seed = String(Date.now());
        state.sort = opt.id;
        closeMenu();
        markSortSelected();
        resetAndLoad();
      });
      sortSection.appendChild(item);
    });
    if (CONFIG.allowOrderSortChange) panel.appendChild(sortSection);

    var containsSection = section('Contains');
    var containsOptions = [
      { id: '', label: 'Anything' },
      { id: 'face', label: 'Faces' },
      { id: 'cat', label: 'Pets' },
      { id: 'text', label: 'Text' },
    ];
    containsOptions.forEach(function (opt) {
      var item = el('button', { class: 'menu-item', 'data-has': opt.id }, '<span>' + opt.label + '</span>');
      item.addEventListener('click', function () {
        state.has = opt.id || null;
        closeMenu();
        refreshContainsHighlight();
        resetAndLoad();
      });
      containsSection.appendChild(item);
    });
    panel.appendChild(containsSection);
    header._containsSection = containsSection; // populated with detected object classes once known
    header._menuPanel = panel;

    var saverSection = section('Performance');
    var saverItem = el('button', {
      class: 'menu-item', 'data-saver-toggle': '1',
      title: 'Fewer autoplay previews and later image loading, for slower connections/hardware. Applies on reload.',
    });
    var saverLabel = el('span', {}, 'Data saver');
    var saverState = el('span', { class: 'menu-item-state' });
    saverItem.appendChild(saverLabel);
    saverItem.appendChild(saverState);
    function paintSaverItem() {
      saverState.textContent = dataSaverMode ? 'On' : 'Off';
      saverItem.classList.toggle('selected', dataSaverMode);
    }
    paintSaverItem();
    saverItem.addEventListener('click', function () {
      dataSaverMode = !dataSaverMode;
      try { localStorage.setItem('stream-data-saver', dataSaverMode ? '1' : '0'); } catch (e) { /* ignore */ }
      location.reload();
    });
    saverSection.appendChild(saverItem);
    panel.appendChild(saverSection);

    var densitySection = section('Grid size');
    DENSITIES.forEach(function (d) {
      var item = el('button', { class: 'menu-item', 'data-density': d.id }, '<span>' + d.label + '</span>');
      item.addEventListener('click', function () {
        applyDensity(d.id);
        markDensitySelected();
        remeasureAndReflow();
        closeMenu();
      });
      densitySection.appendChild(item);
    });
    panel.appendChild(densitySection);

    var themeSection = section('Theme');
    THEMES.forEach(function (t) {
      var swatchHtml = t.swatch ? '<span class="swatch" style="background:' + t.swatch + '"></span>' : '<span class="swatch" style="background:linear-gradient(135deg,#a83831,#c1443c)"></span>';
      var item = el('button', { class: 'menu-item', 'data-theme-opt': t.id }, '<span>' + t.label + '</span>' + swatchHtml);
      item.addEventListener('click', function () {
        applyTheme(t.id);
        markThemeSelected();
        closeMenu();
      });
      themeSection.appendChild(item);
    });
    panel.appendChild(themeSection);

    function markSortSelected() {
      Array.prototype.forEach.call(sortSection.querySelectorAll('.menu-item'), function (b) {
        b.classList.toggle('selected', b.dataset.sort === state.sort);
      });
    }
    function markDensitySelected() {
      Array.prototype.forEach.call(densitySection.querySelectorAll('.menu-item'), function (b) {
        b.classList.toggle('selected', b.dataset.density === currentDensity);
      });
    }
    function markThemeSelected() {
      Array.prototype.forEach.call(themeSection.querySelectorAll('.menu-item'), function (b) {
        b.classList.toggle('selected', b.dataset.themeOpt === currentTheme);
      });
    }
    markSortSelected();
    refreshContainsHighlight();
    markDensitySelected();
    markThemeSelected();

    function openMenu() {
      panel.classList.add('open');
      document.addEventListener('click', outsideClick, true);
    }
    function closeMenu() {
      panel.classList.remove('open');
      document.removeEventListener('click', outsideClick, true);
    }
    function outsideClick(e) {
      if (!wrap.contains(e.target)) closeMenu();
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.classList.contains('open')) closeMenu();
      else openMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    wrap.appendChild(trigger);
    wrap.appendChild(panel);
    return wrap;
  }

  function remeasureAndReflow() {
    measureColumns();
    Array.prototype.forEach.call(grid.querySelectorAll('.tile'), function (tile) {
      if (tile._item) applySpan(tile, tile._item);
    });
  }

  // ---------------------------------------------------------------
  // Search (filename + OCR text)
  // ---------------------------------------------------------------

  function buildSearch() {
    var wrap = el('div', { class: 'search-wrap' });
    var toggle = el('button', { class: 'icon-btn', title: 'Search', 'aria-label': 'Search' }, icon('search'));
    var input = el('input', {
      type: 'search', class: 'search-input', placeholder: 'Search filenames and text in photos…',
      'aria-label': 'Search photos and videos',
    });

    var debounceTimer = null;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        state.q = input.value.trim();
        resetAndLoad();
      }, 350);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; state.q = ''; resetAndLoad(); closeSearch(); }
    });

    function openSearch() {
      wrap.classList.add('open');
      setTimeout(function () { input.focus(); }, 50);
    }
    function closeSearch() {
      wrap.classList.remove('open');
    }
    toggle.addEventListener('click', function () {
      if (wrap.classList.contains('open') && !input.value) closeSearch();
      else openSearch();
    });

    wrap.appendChild(toggle);
    wrap.appendChild(input);
    return wrap;
  }

  // ---------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------

  function renderHeader() {
    var title = el('div', { class: 'header-title' });
    title.textContent = CONFIG.title;

    var controls = el('div', { class: 'header-controls' });

    var typeSelect = el('select', { class: 'filter-select', 'aria-label': 'Filter by type' },
      '<option value="">All</option><option value="photo">Photos</option><option value="video">Videos</option>');
    typeSelect.addEventListener('change', function () {
      state.type = typeSelect.value || null;
      resetAndLoad();
    });
    controls.appendChild(typeSelect);

    var albumSelect = el('select', { class: 'filter-select', 'aria-label': 'Filter by album', style: 'display:none' });
    albumSelect.addEventListener('change', function () {
      state.album = albumSelect.value || null;
      resetAndLoad();
      renderAlbumBulkAction();
    });
    controls.appendChild(albumSelect);
    header._albumSelect = albumSelect;

    controls.appendChild(buildSearch());

    var selectBtn = el('button', { class: 'icon-btn', title: 'Select', 'aria-label': 'Select photos and videos' }, icon('checkCircle'));
    selectBtn.addEventListener('click', function () {
      if (selection.active) exitSelectionMode(); else enterSelectionMode();
    });
    controls.appendChild(selectBtn);
    header._selectBtn = selectBtn;

    controls.appendChild(buildMenu());

    var rescanBtn = el('button', { class: 'icon-btn', title: 'Rescan library', 'aria-label': 'Rescan library' }, icon('refresh'));
    rescanBtn.addEventListener('click', function () {
      rescanBtn.style.opacity = '0.4';
      fetch('/api/rescan', { method: 'POST' })
        .then(function () { resetAndLoad(); fetchLibraryStatus(); showToast('Library rescanned'); })
        .catch(function () { showToast('Rescan failed'); })
        .finally(function () { rescanBtn.style.opacity = ''; });
    });
    controls.appendChild(rescanBtn);

    if (CONFIG.showRssFeed) {
      var rssLink = el('a', { class: 'icon-btn', href: '/feed.xml', title: 'RSS feed', 'aria-label': 'RSS feed' }, icon('rss'));
      controls.appendChild(rssLink);
    }

    if (isAdmin) {
      controls.appendChild(el('span', { class: 'admin-badge' }, 'Admin'));
    } else if (CONFIG.adminEnabled) {
      var signInBtn = el('button', { class: 'icon-btn', title: 'Admin sign in', 'aria-label': 'Admin sign in' }, icon('eye'));
      signInBtn.addEventListener('click', function () { signInModal.open(); });
      controls.appendChild(signInBtn);
    }

    header.appendChild(title);
    header.appendChild(controls);
  }

  // ---------------------------------------------------------------
  // Library summary (Google-Photos-style counts) and the lists of files
  // that didn't make it in, behind the "unsupported"/"unreadable" chips
  // ---------------------------------------------------------------

  function plural(n, word) { return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's'); }

  function buildLibrarySummary() {
    return { root: el('div', { class: 'library-summary mono' }) };
  }

  function renderLibrarySummary() {
    var s = libraryStatus && libraryStatus.stats;
    var root = librarySummary.root;
    root.innerHTML = '';
    if (!s || !s.total) return;
    root.appendChild(el('span', {}, plural(s.photoCount, 'photo')));
    root.appendChild(el('span', {}, plural(s.videoCount, 'video')));
    if (s.unsupportedCount > 0) {
      var u = el('button', { type: 'button', title: 'See which files were not imported' }, s.unsupportedCount.toLocaleString() + ' unsupported');
      u.addEventListener('click', function () { filesModal.open(); });
      root.appendChild(u);
    }
    if (s.failedCount > 0) {
      var f = el('button', { type: 'button', title: 'See which files could not be read' }, s.failedCount.toLocaleString() + ' unreadable');
      f.addEventListener('click', function () { filesModal.open(); });
      root.appendChild(f);
    }
    // total includes unsupported and unreadable files, so it matches what's actually in the folder
    root.appendChild(el('span', { class: 'total' }, s.total.toLocaleString() + ' total'));
  }

  function fetchLibraryStatus() {
    return fetch('/api/library-status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) { libraryStatus = data; renderLibrarySummary(); } })
      .catch(function () { /* the summary is a nicety; never block the app on it */ });
  }

  function buildFilesModal() {
    var scrim = el('div', { class: 'modal-scrim' });
    var card = el('div', { class: 'modal-card wide', role: 'dialog', 'aria-modal': 'true' });
    var title = el('h1');
    title.textContent = 'Files not in the library';
    var sub = el('p', { class: 'modal-sub' }, 'Grouped by folder, so you can go check them.');
    var body = el('div', { class: 'files-body' });
    var actions = el('div', { class: 'files-actions' });
    var copyBtn = el('button', { type: 'button', class: 'modal-cancel' }, 'Copy list');
    var closeBtn = el('button', { type: 'button', class: 'modal-cancel' }, 'Close');
    actions.appendChild(copyBtn);
    actions.appendChild(closeBtn);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(body);
    card.appendChild(actions);
    scrim.appendChild(card);

    var plainText = '';
    function dirOf(p) { var i = p.lastIndexOf('/'); return i === -1 ? '(top level)' : p.slice(0, i); }
    function baseOf(p) { var i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }

    function addSection(heading, note, entries, detailOf) {
      if (!entries.length) return;
      var sec = el('div', { class: 'files-section' });
      var h = el('h2');
      h.textContent = heading + ' (' + entries.length + ')';
      sec.appendChild(h);
      var n = el('p', { class: 'files-help' });
      n.textContent = note;
      sec.appendChild(n);
      var byDir = {};
      entries.forEach(function (e) {
        var d = dirOf(e.relPath);
        (byDir[d] = byDir[d] || []).push(e);
      });
      Object.keys(byDir).sort().forEach(function (dir) {
        var d = el('div', { class: 'files-dir' });
        d.textContent = dir;
        sec.appendChild(d);
        plainText += '\n[' + heading + '] ' + dir + '\n';
        byDir[dir].forEach(function (e) {
          var row = el('div', { class: 'files-row' });
          var name = el('span', { class: 'files-name' });
          name.textContent = baseOf(e.relPath);
          var detail = el('span', { class: 'files-note' });
          detail.textContent = detailOf(e);
          row.appendChild(name);
          row.appendChild(detail);
          sec.appendChild(row);
          plainText += '  ' + baseOf(e.relPath) + (detailOf(e) ? '  -- ' + detailOf(e) : '') + '\n';
        });
      });
      body.appendChild(sec);
    }

    function open() {
      var st = libraryStatus || {};
      body.innerHTML = '';
      plainText = '';
      addSection('Unsupported format',
        'Not an image or video type Stream imports. Convert them to a supported format and they appear on the next rescan.',
        st.unsupported || [], function (e) { return e.ext; });
      addSection('Unreadable',
        'A supported type, but the file could not be read -- often a corrupt or truncated file, or a variant the decoder cannot handle.',
        st.failed || [], function (e) { return e.error; });
      if (!body.children.length) {
        body.appendChild(el('p', { class: 'files-help' }, 'Nothing to report -- every file was imported.'));
      }
      scrim.classList.add('open');
    }
    function close() { scrim.classList.remove('open'); }
    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    copyBtn.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(plainText.trim()).then(function () { showToast('List copied'); });
    });

    return { root: scrim, open: open, close: close };
  }

  function renderBottomLinks() {
    var items = [];
    if (CONFIG.githubUsername) items.push({ label: 'GitHub', href: 'https://github.com/' + CONFIG.githubUsername });
    if (CONFIG.twitterUsername) items.push({ label: 'Twitter', href: 'https://twitter.com/' + CONFIG.twitterUsername });
    if (CONFIG.instagramUsername) items.push({ label: 'Instagram', href: 'https://instagram.com/' + CONFIG.instagramUsername });
    if (CONFIG.customLinkUrl && CONFIG.customLinkName) items.push({ label: CONFIG.customLinkName, href: CONFIG.customLinkUrl });
    if (isAdmin) {
      var logout = el('li');
      var btn = el('button', {}, 'Sign out');
      btn.addEventListener('click', function () {
        fetch('/api/logout', { method: 'POST' }).then(function () { location.href = '/'; });
      });
      logout.appendChild(btn);
      linksBottom.appendChild(logout);
    }
    items.forEach(function (it) {
      var li = el('li');
      var a = el('a', { href: it.href, target: '_blank', rel: 'me noopener' });
      a.textContent = it.label;
      li.appendChild(a);
      linksBottom.appendChild(li);
    });
  }

  // Admin-only: mark every item in the currently-selected album as
  // guest-visible (or private) in one action, next to the album picker.
  var albumBulkEl = null;
  function renderAlbumBulkAction() {
    if (albumBulkEl) { albumBulkEl.remove(); albumBulkEl = null; }
    if (!isAdmin || !state.album) return;
    albumBulkEl = el('div', { class: 'album-bulk-action' });
    var btn = el('button', {}, 'Mark "' + state.album + '" guest-visible');
    var isMakingPrivate = false;
    btn.addEventListener('click', function () {
      var guest = !isMakingPrivate;
      fetch('/api/albums/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ album: state.album, guest: guest }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        showToast((data.changed || 0) + ' item(s) updated');
        isMakingPrivate = guest;
        btn.textContent = guest ? 'Mark "' + state.album + '" private' : 'Mark "' + state.album + '" guest-visible';
        resetAndLoad();
      });
    });
    albumBulkEl.appendChild(btn);
    main.insertBefore(albumBulkEl, grid);
  }

  // ---------------------------------------------------------------
  // Selection mode (iOS-style multi-select + bulk download)
  // ---------------------------------------------------------------

  function buildSelectionBar() {
    var bar = el('div', { class: 'selection-bar' });
    var countEl = el('div', { class: 'selection-count mono' }, '0 selected');
    var actions = el('div', { class: 'selection-actions' });

    var downloadBtn = el('button', { class: 'selection-btn' });
    downloadBtn.innerHTML = icon('download');
    downloadBtn.appendChild(el('span', {}, 'Download'));
    downloadBtn.addEventListener('click', downloadSelected);
    actions.appendChild(downloadBtn);

    var visGuestBtn = null, visPrivateBtn = null;
    if (isAdmin) {
      visGuestBtn = el('button', { class: 'selection-btn' }, 'Make guest-visible');
      visGuestBtn.addEventListener('click', function () { bulkSetVisibility(true); });
      actions.appendChild(visGuestBtn);
      visPrivateBtn = el('button', { class: 'selection-btn' }, 'Make private');
      visPrivateBtn.addEventListener('click', function () { bulkSetVisibility(false); });
      actions.appendChild(visPrivateBtn);
    }

    var cancelBtn = el('button', { class: 'selection-btn selection-cancel' }, 'Cancel');
    cancelBtn.addEventListener('click', exitSelectionMode);
    actions.appendChild(cancelBtn);

    bar.appendChild(countEl);
    bar.appendChild(actions);
    return { root: bar, countEl: countEl };
  }

  function enterSelectionMode() {
    selection.active = true;
    selection.ids.clear();
    grid.classList.add('selecting');
    header._selectBtn.classList.add('active');
    updateSelectionUI();
  }

  function exitSelectionMode() {
    selection.active = false;
    selection.ids.clear();
    grid.classList.remove('selecting');
    header._selectBtn.classList.remove('active');
    Array.prototype.forEach.call(grid.querySelectorAll('.tile.selected'), function (t) {
      t.classList.remove('selected');
    });
    updateSelectionUI();
  }

  function updateSelectionUI() {
    selectionBar.root.classList.toggle('open', selection.active);
    var n = selection.ids.size;
    selectionBar.countEl.textContent = n === 1 ? '1 selected' : n + ' selected';
  }

  function toggleTileSelection(item, tile) {
    if (selection.ids.has(item.id)) {
      selection.ids.delete(item.id);
      tile.classList.remove('selected');
    } else {
      selection.ids.add(item.id);
      tile.classList.add('selected');
    }
    updateSelectionUI();
  }

  function bulkSetVisibility(guest) {
    var ids = Array.from(selection.ids);
    Promise.all(ids.map(function (id) {
      return fetch('/api/items/' + encodeURIComponent(id) + '/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest: guest }),
      });
    })).then(function () {
      showToast(ids.length + ' item(s) updated');
      exitSelectionMode();
      resetAndLoad();
    });
  }

  function downloadSelected() {
    var ids = Array.from(selection.ids);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      var item = grid.querySelector('[data-item-id="' + ids[0] + '"]');
      var url = item && item._item && item._item.urls.download;
      if (url) {
        var a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      return;
    }
    showToast('Preparing download…');
    fetch('/api/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('download failed');
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'stream-' + ids.length + '-items.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      })
      .catch(function () { showToast('Download failed'); });
  }

  // ---------------------------------------------------------------
  // Grid state + data loading
  // ---------------------------------------------------------------

  var sentinel = el('li', { class: 'sentinel' });
  var statusEl = el('div', { class: 'grid-status' });
  statusEl.style.display = 'none';

  var columnWidth = 0;
  function measureColumns() {
    var cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
    columnWidth = cols.length ? parseFloat(cols[0]) : grid.clientWidth;
  }

  function applySpan(tile, item) {
    if (!columnWidth) measureColumns();
    var aspect = item.width && item.height ? item.width / item.height : 1;
    var rowUnit = parseFloat(getComputedStyle(grid).getPropertyValue('grid-auto-rows')) || 4;
    var gap = parseFloat(getComputedStyle(grid).getPropertyValue('gap')) || 3;
    var tileHeight = columnWidth / aspect;
    var span = Math.max(1, Math.ceil((tileHeight + gap) / (rowUnit + gap)));
    tile.style.gridRowEnd = 'span ' + span;
    // Keep the responsive <img>/<video> sizes attribute matching the
    // actual measured column width, so the browser's srcset choice is
    // based on real layout rather than a guessed vw fraction.
    var media = tile.querySelector('img.tile-media, video.tile-media');
    if (media && media.tagName === 'IMG') media.sizes = Math.round(columnWidth) + 'px';
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(remeasureAndReflow, 150);
  });

  function apiUrl(cursor) {
    var params = new URLSearchParams();
    if (state.type) params.set('type', state.type);
    if (state.album) params.set('album', state.album);
    if (state.has) params.set('has', state.has);
    if (state.q) params.set('q', state.q);
    params.set('sort', state.sort);
    if (state.sort === 'random') params.set('seed', state.seed);
    if (cursor) params.set('cursor', cursor);
    return '/api/items?' + params.toString();
  }

  function loadMore() {
    if (state.loading || state.done) return Promise.resolve();
    state.loading = true;
    var myToken = state.loadToken;
    statusEl.style.display = 'block';
    statusEl.textContent = 'Loading…';
    return fetch(apiUrl(state.cursor))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (myToken !== state.loadToken) return; // superseded by a filter/sort change; discard
        state.loadedOnce = true;
        updateAlbumOptions(data.albums);
        updateObjectClassOptions(data.objectClasses);
        if (data.items.length === 0 && !state.cursor) {
          showEmptyState();
        } else {
          hideEmptyState();
          data.items.forEach(addTile);
        }
        state.cursor = data.nextCursor;
        state.done = !data.nextCursor;
        statusEl.style.display = 'none';
        state.loading = false;
        grid.appendChild(sentinel);
      })
      .catch(function () {
        if (myToken !== state.loadToken) return;
        statusEl.textContent = 'Could not load — check your connection and try again.';
        state.loading = false;
      });
  }

  function resetAndLoad() {
    // Bumping the token makes any still-in-flight request from before
    // this reset a no-op when it resolves, even though state.loading
    // is being force-cleared below to let the new request start
    // immediately -- see the token check in loadMore().
    state.loadToken = (state.loadToken || 0) + 1;
    state.loading = false;
    grid.classList.add('refreshing');
    grid.innerHTML = '';
    state.cursor = null;
    state.done = false;
    loadMore().finally(function () { grid.classList.remove('refreshing'); });
  }

  var albumSelectPopulated = false;
  function updateAlbumOptions(albums) {
    if (albumSelectPopulated || !albums || albums.length === 0) return;
    albumSelectPopulated = true;
    var sel = header._albumSelect;
    sel.innerHTML = '<option value="">All albums</option>' + albums.map(function (a) {
      return '<option value="' + a.replace(/"/g, '&quot;') + '">' + a + '</option>';
    }).join('');
    sel.style.display = '';
  }

  function refreshContainsHighlight() {
    if (!header._containsSection) return;
    Array.prototype.forEach.call(header._containsSection.querySelectorAll('.menu-item'), function (b) {
      b.classList.toggle('selected', b.dataset.has === (state.has || ''));
    });
  }

  // Populates the Contains menu with whatever object classes YOLO has
  // actually found in this library (e.g. "dog", "car") -- a fixed
  // guessed list wouldn't match what's really in any given library, and
  // this is empty (a harmless no-op) when object detection is off.
  var objectClassesPopulated = false;
  function updateObjectClassOptions(classes) {
    if (objectClassesPopulated || !classes || classes.length === 0 || !header._containsSection) return;
    objectClassesPopulated = true;
    var section = header._containsSection;
    section.appendChild(el('div', { class: 'menu-divider' }));
    classes.forEach(function (cls) {
      var item = el('button', { class: 'menu-item', 'data-has': cls }, '<span>' + cls + '</span>');
      item.addEventListener('click', function () {
        state.has = cls;
        refreshContainsHighlight();
        resetAndLoad();
        if (header._menuPanel) header._menuPanel.classList.remove('open');
      });
      section.appendChild(item);
    });
  }

  function showEmptyState() {
    var empty = el('div', { class: 'empty', id: 'empty-state' },
      '<div class="empty-mark"></div><h2>Nothing here yet</h2><p>Drop photos or videos into your media folder — they\'ll show up here automatically.</p>');
    main.appendChild(empty);
  }
  function hideEmptyState() {
    var existing = document.getElementById('empty-state');
    if (existing) existing.remove();
  }

  // ---------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------

  var lazyObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var img = entry.target;
      if (img.dataset.srcset) img.srcset = img.dataset.srcset;
      img.src = img.dataset.src;
      lazyObserver.unobserve(img);
    });
  }, { rootMargin: dataSaverMode ? '100px' : '500px' });

  var inViewVideoTiles = new Set();
  var autoplayObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var tile = entry.target;
      if (entry.isIntersecting) {
        inViewVideoTiles.add(tile);
        playPreview(tile);
      } else {
        inViewVideoTiles.delete(tile);
        pausePreview(tile);
      }
    });
  }, { rootMargin: '80px', threshold: 0.4 });

  var scrollObserver = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) loadMore();
  }, { rootMargin: '900px' });
  scrollObserver.observe(sentinel);

  function attachVideoPreview(tile, item) {
    if (tile._video) return tile._video;
    var video = document.createElement('video');
    video.className = 'tile-media tile-video-el';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.src = item.urls.preview || item.urls.full;
    tile.appendChild(video);
    var liveEl = tile.querySelector('.tile-live');
    video.addEventListener('playing', function () {
      video.classList.add('playing');
      if (liveEl) liveEl.classList.add('on');
    });
    video.addEventListener('pause', function () {
      video.classList.remove('playing');
      if (liveEl) liveEl.classList.remove('on');
    });
    tile._video = video;
    return video;
  }

  function playPreview(tile) {
    if (tile._item.type !== 'video') return;
    var video = attachVideoPreview(tile, tile._item);
    var p = video.play();
    if (p && p.catch) p.catch(function () { /* blocked until a user gesture; hover covers that */ });
  }
  function pausePreview(tile) {
    if (tile._video) tile._video.pause();
  }

  function paintVisibilityButton(btn, guest) {
    btn.classList.toggle('is-guest', guest);
    btn.innerHTML = icon(guest ? 'eye' : 'eyeOff');
    btn.title = guest ? 'Guest-visible — click to make private' : 'Private — click to make guest-visible';
  }

  // Updates every rendered instance of this item's visibility toggle --
  // the grid tile (if currently rendered) and the lightbox button (if
  // this item is the one currently open) are separate DOM elements, so
  // toggling from one must not leave the other showing stale state.
  function syncVisibilityUI(item) {
    var tile = grid.querySelector('[data-item-id="' + item.id + '"] .tile-visibility');
    if (tile) paintVisibilityButton(tile, item.guest);
    if (lb.item && lb.item.id === item.id) paintVisibilityButton(lightbox.visBtn, item.guest);
  }

  function toggleItemVisibility(item) {
    var next = !item.guest;
    fetch('/api/items/' + encodeURIComponent(item.id) + '/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest: next }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        item.guest = data.item.guest;
        syncVisibilityUI(item);
        showToast(item.guest ? 'Now guest-visible' : 'Now private');
      })
      .catch(function () { showToast('Could not update visibility'); });
  }

  function addTile(item) {
    var tile = el('li', { class: 'tile', tabindex: '0', role: 'button', 'aria-label': 'Open ' + item.filename, 'data-item-id': item.id });
    tile.style.background = item.color;
    tile._item = item;

    var img = el('img', { class: 'tile-media', alt: '', loading: 'lazy' });
    img.dataset.src = item.urls.thumb;
    if (item.urls.thumbSrcset) img.dataset.srcset = item.urls.thumbSrcset;
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    tile.appendChild(img);
    lazyObserver.observe(img);

    if (item.type === 'video') {
      var live = el('span', { class: 'tile-live' }, '<span class="tile-live-dot"></span>LIVE');
      tile.appendChild(live);
      if (item.duration) {
        tile.appendChild(el('span', { class: 'tile-duration mono' }, formatDuration(item.duration)));
      }
      if (canHover) {
        tile.addEventListener('pointerenter', function () { playPreview(tile); });
        tile.addEventListener('pointerleave', function () {
          if (!inViewVideoTiles.has(tile)) pausePreview(tile);
        });
      }
      if (autoplayEnabled) autoplayObserver.observe(tile);
    }

    if (isAdmin) {
      var visBtn = el('button', { class: 'tile-visibility', 'aria-label': 'Toggle guest visibility' });
      paintVisibilityButton(visBtn, item.guest);
      visBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleItemVisibility(item);
      });
      tile.appendChild(visBtn);
    }

    var selectMark = el('span', { class: 'tile-select-mark' }, icon('checkCircle'));
    tile.appendChild(selectMark);
    if (selection.active && selection.ids.has(item.id)) tile.classList.add('selected');

    tile.addEventListener('click', function () {
      if (selection.active) toggleTileSelection(item, tile);
      else openLightbox(item, true);
    });
    tile.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (selection.active) toggleTileSelection(item, tile);
      else openLightbox(item, true);
    });

    if (bg) {
      bg.watchTile(tile, item.color);
      tile.addEventListener('pointerenter', function () { bg.setHoverColor(item.color); });
    }
    grid.appendChild(tile);
    applySpan(tile, item);
  }

  // ---------------------------------------------------------------
  // Lightbox
  // ---------------------------------------------------------------

  function buildLightbox() {
    var root = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' });
    var bar = el('div', { class: 'lightbox-bar' });
    var counter = el('div', { class: 'frame-counter mono' }, '');
    var actions = el('div', { class: 'lightbox-actions' });
    var visBtn = el('button', { class: 'icon-btn', title: 'Toggle guest visibility', 'aria-label': 'Toggle guest visibility', style: 'display:none' }, icon('eyeOff'));
    var slideshowBtn = el('button', { class: 'icon-btn', title: 'Play slideshow', 'aria-label': 'Play slideshow' }, icon('play'));
    var editBtn = el('button', { class: 'icon-btn', title: 'Quick edit', 'aria-label': 'Quick edit' }, icon('edit'));
    var infoBtn = el('button', { class: 'icon-btn', title: 'Info', 'aria-label': 'Photo/video info' }, icon('info'));
    var shareBtn = el('button', { class: 'icon-btn', title: 'Share', 'aria-label': 'Share' }, icon('share'));
    var downloadLink = el('a', { class: 'icon-btn', title: 'Download original', 'aria-label': 'Download original' }, icon('download'));
    var closeBtn = el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close' }, icon('close'));
    actions.appendChild(visBtn);
    actions.appendChild(slideshowBtn);
    actions.appendChild(editBtn);
    actions.appendChild(infoBtn);
    actions.appendChild(shareBtn);
    actions.appendChild(downloadLink);
    actions.appendChild(closeBtn);
    bar.appendChild(counter);
    bar.appendChild(actions);

    var stage = el('div', { class: 'lightbox-stage' });
    var prevBtn = el('button', { class: 'lightbox-nav prev', 'aria-label': 'Previous' }, icon('chevronLeft'));
    var nextBtn = el('button', { class: 'lightbox-nav next', 'aria-label': 'Next' }, icon('chevronRight'));
    var mediaWrap = el('div', { class: 'lightbox-media-wrap' });
    stage.appendChild(prevBtn);
    stage.appendChild(mediaWrap);
    stage.appendChild(nextBtn);

    var caption = el('div', { class: 'lightbox-caption mono' }, '');

    // Quick edit toolbar: rotate + brightness always, volume for video
    // only. Session-only -- reset whenever renderLightboxMedia() shows
    // a different item, never written back to the file.
    var editPanel = el('div', { class: 'edit-panel' });
    var rotateBtn = el('button', { class: 'icon-btn', title: 'Rotate 90°', 'aria-label': 'Rotate 90 degrees' }, icon('rotate'));
    var brightnessGroup = el('div', { class: 'edit-slider-group' });
    brightnessGroup.appendChild(el('span', { class: 'edit-slider-label' }, 'Brightness'));
    var brightnessSlider = el('input', { type: 'range', min: '50', max: '150', value: '100', class: 'edit-slider' });
    brightnessGroup.appendChild(brightnessSlider);
    var volumeGroup = el('div', { class: 'edit-slider-group', style: 'display:none' });
    volumeGroup.appendChild(el('span', { class: 'edit-slider-label' }, 'Volume'));
    var volumeSlider = el('input', { type: 'range', min: '0', max: '100', value: '100', class: 'edit-slider' });
    volumeGroup.appendChild(volumeSlider);
    editPanel.appendChild(rotateBtn);
    editPanel.appendChild(brightnessGroup);
    editPanel.appendChild(volumeGroup);

    // Info sidebar: read-only metadata, populated per-item in
    // renderInfoPanel() below.
    var infoPanel = el('div', { class: 'info-panel' });
    var infoHeader = el('div', { class: 'info-panel-header' });
    infoHeader.appendChild(el('span', {}, 'Info'));
    var infoCloseBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close info' }, icon('close'));
    infoHeader.appendChild(infoCloseBtn);
    var infoList = el('dl', { class: 'info-list' });
    infoPanel.appendChild(infoHeader);
    infoPanel.appendChild(infoList);

    root.appendChild(bar);
    root.appendChild(stage);
    root.appendChild(caption);
    root.appendChild(editPanel);
    root.appendChild(infoPanel);

    closeBtn.addEventListener('click', function () { stopSlideshow(); closeLightbox(); });
    root.addEventListener('click', function (e) { if (e.target === root || e.target === stage) { stopSlideshow(); closeLightbox(); } });
    prevBtn.addEventListener('click', function () { stopSlideshow(); navigate(-1); });
    nextBtn.addEventListener('click', function () { stopSlideshow(); navigate(1); });
    shareBtn.addEventListener('click', shareCurrent);
    visBtn.addEventListener('click', function () { toggleItemVisibility(lb.item); });
    slideshowBtn.addEventListener('click', toggleSlideshow);

    editBtn.addEventListener('click', function () {
      editPanel.classList.toggle('open');
      editBtn.classList.toggle('active', editPanel.classList.contains('open'));
      infoPanel.classList.remove('open');
      infoBtn.classList.remove('active');
    });
    infoBtn.addEventListener('click', function () {
      infoPanel.classList.toggle('open');
      infoBtn.classList.toggle('active', infoPanel.classList.contains('open'));
      editPanel.classList.remove('open');
      editBtn.classList.remove('active');
    });
    infoCloseBtn.addEventListener('click', function () {
      infoPanel.classList.remove('open');
      infoBtn.classList.remove('active');
    });

    rotateBtn.addEventListener('click', function () {
      editState.rotation = (editState.rotation + 90) % 360;
      applyEditState();
    });
    brightnessSlider.addEventListener('input', function () {
      editState.brightness = Number(brightnessSlider.value);
      applyEditState();
    });
    volumeSlider.addEventListener('input', function () {
      editState.volume = Number(volumeSlider.value);
      applyEditState();
    });

    return {
      root: root, counter: counter, mediaWrap: mediaWrap, prevBtn: prevBtn, nextBtn: nextBtn,
      caption: caption, downloadLink: downloadLink, visBtn: visBtn, slideshowBtn: slideshowBtn,
      editBtn: editBtn, infoBtn: infoBtn, editPanel: editPanel, infoPanel: infoPanel, infoList: infoList,
      rotateBtn: rotateBtn, brightnessSlider: brightnessSlider, volumeGroup: volumeGroup, volumeSlider: volumeSlider,
    };
  }

  var lb = {
    open: false,
    item: null,
    index: -1,
    total: 0,
    prev: null,
    next: null,
    openedFromGrid: false,
  };

  var slideshow = { active: false, timer: null };
  function startSlideshow() {
    if (!lb.next) return;
    slideshow.active = true;
    lightbox.slideshowBtn.innerHTML = icon('pause');
    lightbox.slideshowBtn.classList.add('is-playing-slideshow');
    lightbox.slideshowBtn.title = 'Pause slideshow';
    // If a video is already showing when Play is pressed, its "ended"
    // listener was never attached (slideshow wasn't active yet when
    // renderLightboxMedia ran for it) -- bind it retroactively so the
    // slideshow doesn't just stall on the current item.
    if (lb.item && lb.item.type === 'video') bindSlideshowEnded(lightbox.mediaWrap.querySelector('video'));
    scheduleSlideshowAdvance();
  }
  function stopSlideshow() {
    slideshow.active = false;
    clearTimeout(slideshow.timer);
    lightbox.slideshowBtn.innerHTML = icon('play');
    lightbox.slideshowBtn.classList.remove('is-playing-slideshow');
    lightbox.slideshowBtn.title = 'Play slideshow';
  }
  function toggleSlideshow() {
    if (slideshow.active) stopSlideshow(); else startSlideshow();
  }
  function scheduleSlideshowAdvance() {
    clearTimeout(slideshow.timer);
    if (!slideshow.active) return;
    // A video's own "ended" event (attached in renderLightboxMedia)
    // drives the advance instead of a fixed timer -- otherwise a video
    // longer than the interval gets cut off, and one shorter than it
    // would advance twice (once on "ended", again when this timer
    // still fires afterwards).
    if (lb.item && lb.item.type === 'video') return;
    slideshow.timer = setTimeout(function () {
      if (!slideshow.active) return;
      if (!lb.next) { stopSlideshow(); return; }
      navigate(1, true);
    }, 5000);
  }

  function bindSlideshowEnded(video) {
    if (!video || video._slideshowEndedBound) return;
    video._slideshowEndedBound = true;
    video.addEventListener('ended', function () {
      if (slideshow.active) navigate(1, true);
    });
  }

  // Quick edits are session-only (never written back to the file) and
  // scoped to whatever's currently open -- reset every time a
  // different item is shown, applied via CSS transform/filter (or,
  // for volume, the real media element property) rather than any
  // server-side processing.
  var editState = { rotation: 0, brightness: 100, volume: 100 };

  function resetEditState() {
    editState.rotation = 0;
    editState.brightness = 100;
    editState.volume = 100;
    lightbox.brightnessSlider.value = '100';
    lightbox.volumeSlider.value = '100';
    lightbox.editPanel.classList.remove('open');
    lightbox.editBtn.classList.remove('active');
  }

  function applyEditState() {
    var media = lightbox.mediaWrap.querySelector('img, video');
    if (!media) return;
    media.style.transform = editState.rotation ? 'rotate(' + editState.rotation + 'deg)' : '';
    media.style.filter = editState.brightness !== 100 ? 'brightness(' + editState.brightness + '%)' : '';
    if (media.tagName === 'VIDEO') media.volume = editState.volume / 100;
  }

  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return null;
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes;
    for (var i = 0; i < units.length; i++) {
      v /= 1024;
      if (v < 1024 || i === units.length - 1) return v.toFixed(v < 10 ? 2 : 1) + ' ' + units[i];
    }
  }

  function infoRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return '<dt>' + label + '</dt><dd>' + String(value).replace(/</g, '&lt;') + '</dd>';
  }

  function renderInfoPanel(item) {
    var info = item.info || {};
    var cam = info.camera || {};
    var tech = info.tech || {};
    var rows = '';
    rows += infoRow('Filename', info.filename);
    rows += infoRow('Type', item.type === 'photo' ? 'Photo' + (item.isAnimated ? ' (animated)' : '') : 'Video');
    if (item.width && item.height) rows += infoRow('Dimensions', item.width + ' × ' + item.height);
    rows += infoRow('Size', formatFileSize(info.size));
    rows += infoRow('Album', info.album);
    rows += infoRow('Date', item.date ? new Date(item.date).toLocaleString() + (item.dateExact ? '' : ' (estimated)') : null);
    if (item.type === 'video') {
      rows += infoRow('Duration', item.duration ? formatDuration(item.duration) : null);
      rows += infoRow('Video codec', tech.videoCodec);
      rows += infoRow('Audio codec', tech.audioCodec);
      rows += infoRow('Frame rate', tech.frameRate ? tech.frameRate + ' fps' : null);
      rows += infoRow('Bit rate', tech.bitRate ? Math.round(tech.bitRate / 1000) + ' kbps' : null);
    }
    if (cam.make || cam.model) rows += infoRow('Camera', [cam.make, cam.model].filter(Boolean).join(' '));
    rows += infoRow('Lens', cam.lens);
    rows += infoRow('Aperture', cam.aperture ? 'f/' + cam.aperture : null);
    rows += infoRow('Exposure', cam.exposureTime ? cam.exposureTime + ' s' : null);
    rows += infoRow('ISO', cam.iso);
    rows += infoRow('Focal length', cam.focalLength ? cam.focalLength + ' mm' : null);
    if (item.hasFace) rows += infoRow('Faces detected', item.faceCount || 'yes');
    if (item.objects && item.objects.length) rows += infoRow('Detected', item.objects.join(', '));
    if (item.hasText) rows += infoRow('Text found', item.ocrText);
    lightbox.infoList.innerHTML = rows || '<dt>No details available</dt>';
  }

  function renderLightboxMedia(item) {
    resetEditState();
    if (bg) bg.detachAudio();
    lightbox.mediaWrap.innerHTML = '';
    lightbox.mediaWrap.style.background = item.color;
    var media;
    if (item.type === 'photo') {
      media = el('img', { src: item.urls.full, alt: item.filename });
      if (item.urls.fullSrcset) media.srcset = item.urls.fullSrcset;
    } else {
      media = document.createElement('video');
      media.src = item.urls.full;
      media.controls = true;
      media.playsInline = true;
      media.autoplay = true;
      media.poster = item.urls.thumb;
      if (slideshow.active) bindSlideshowEnded(media);
    }
    lightbox.mediaWrap.appendChild(media);
    if (bg && item.type === 'video') { bg.setHoverColor(item.color); bg.attachAudio(media); }
    lightbox.volumeGroup.style.display = item.type === 'video' ? '' : 'none';
  }

  function updateLightboxChrome() {
    var digits = String(lb.total).length;
    var idx = String(lb.index + 1).padStart(digits, '0');
    var total = String(lb.total).padStart(digits, '0');
    lightbox.counter.innerHTML = idx + '<span class="sep">/</span>' + total;
    lightbox.prevBtn.disabled = !lb.prev;
    lightbox.nextBtn.disabled = !lb.next;
    lightbox.caption.textContent = lb.item.filename;
    if (lb.item.urls.download) {
      lightbox.downloadLink.href = lb.item.urls.download;
      lightbox.downloadLink.style.display = '';
      lightbox.downloadLink.setAttribute('download', '');
    } else {
      lightbox.downloadLink.style.display = 'none';
    }
    lightbox.root.querySelector('.icon-btn[title="Share"]').style.display = CONFIG.allowSharing ? '' : 'none';
    if (isAdmin) {
      lightbox.visBtn.style.display = '';
      paintVisibilityButton(lightbox.visBtn, lb.item.guest);
    } else {
      lightbox.visBtn.style.display = 'none';
    }
    renderInfoPanel(lb.item);
  }

  function fetchNeighbors(id) {
    var params = new URLSearchParams();
    params.set('sort', state.sort);
    if (state.sort === 'random') params.set('seed', state.seed);
    if (state.type) params.set('type', state.type);
    if (state.album) params.set('album', state.album);
    if (state.has) params.set('has', state.has);
    if (state.q) params.set('q', state.q);
    return fetch('/api/item/' + encodeURIComponent(id) + '?' + params.toString()).then(function (r) { return r.json(); });
  }

  function openLightbox(item, fromGrid) {
    lb.open = true;
    if (fromGrid) lb.openedFromGrid = true; // never reset to false here — navigate() relies on this persisting across prev/next
    lb.item = item;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('lb-open');
    lightbox.root.classList.add('open');
    renderLightboxMedia(item);
    if (fromGrid) {
      history.pushState({ streamItem: item.id }, '', '/' + item.id);
    }
    fetchNeighbors(item.id).then(function (data) {
      if (!lb.open || lb.item.id !== item.id) return;
      lb.index = data.index;
      lb.total = data.total;
      lb.prev = data.prev;
      lb.next = data.next;
      updateLightboxChrome();
    });
    updateLightboxChrome();
  }

  function closeLightboxUI() {
    if (!lb.open) return;
    lb.open = false;
    lightbox.root.classList.remove('open');
    document.body.classList.remove('lb-open');
    if (bg) bg.detachAudio();
    lightbox.editPanel.classList.remove('open');
    lightbox.editBtn.classList.remove('active');
    lightbox.infoPanel.classList.remove('open');
    lightbox.infoBtn.classList.remove('active');
    document.body.style.overflow = '';
    var wrap = lightbox.mediaWrap;
    setTimeout(function () {
      var v = wrap.querySelector('video');
      if (v) v.pause();
      wrap.innerHTML = '';
    }, 250);
  }

  // User-initiated close (X button, Escape, backdrop click): also
  // updates history. Reacting to browser back/forward should NOT call
  // this — see the popstate handler, which uses closeLightboxUI directly
  // since the history change already happened.
  function closeLightbox() {
    if (!lb.open) return;
    closeLightboxUI();
    if (lb.openedFromGrid) {
      history.back();
    } else if (location.pathname !== '/') {
      history.pushState({}, '', '/');
    }
  }

  function navigate(dir, fromSlideshow) {
    var target = dir < 0 ? lb.prev : lb.next;
    if (!target) return;
    openLightbox(target, false);
    history.replaceState({ streamItem: target.id }, '', '/' + target.id);
    if (fromSlideshow) scheduleSlideshowAdvance();
  }

  window.addEventListener('popstate', function () {
    stopSlideshow();
    var m = location.pathname.match(/^\/([^/]+)$/);
    if (m && m[1]) {
      fetchNeighbors(m[1]).then(function (data) {
        if (data.item) openLightbox(data.item, false);
      });
    } else {
      closeLightboxUI();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!lb.open) return;
    if (e.key === 'Escape') { stopSlideshow(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { stopSlideshow(); navigate(-1); }
    else if (e.key === 'ArrowRight') { stopSlideshow(); navigate(1); }
    else if (e.key === ' ') {
      var v = lightbox.mediaWrap.querySelector('video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
  });

  var touchStartX = null;
  lightbox.root.addEventListener('touchstart', function (e) { touchStartX = e.touches[0].clientX; }, { passive: true });
  lightbox.root.addEventListener('touchend', function (e) {
    if (touchStartX === null) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) { stopSlideshow(); navigate(dx > 0 ? -1 : 1); }
    touchStartX = null;
  }, { passive: true });

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  function shareCurrent() {
    if (!lb.item) return;
    var url = (CONFIG.url || location.origin) + '/' + lb.item.id;
    if (navigator.share) {
      navigator.share({ title: lb.item.filename, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { showToast('Link copied'); });
    }
  }

  // ---------------------------------------------------------------
  // Admin sign-in modal
  // ---------------------------------------------------------------

  function buildSignInModal(opts) {
    var locked = Boolean(opts && opts.locked);
    var scrim = el('div', { class: 'modal-scrim' + (locked ? ' locked' : '') });
    var card = el('form', { class: 'modal-card' });
    card.appendChild(el('div', { class: 'modal-mark', 'aria-hidden': 'true' }));
    var heading = el('h1');
    heading.textContent = locked ? CONFIG.title : 'Sign in';
    card.appendChild(heading);
    var sub = el('p', { class: 'modal-sub' }, locked ? 'This stream is private. Sign in to continue.' : 'Sign in to see the full library.');
    card.appendChild(sub);
    var userInput = el('input', { type: 'text', name: 'username', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    card.appendChild(userInput);
    var input = el('input', { type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    card.appendChild(input);
    var submit = el('button', { type: 'submit' }, 'Sign in');
    card.appendChild(submit);
    var cancel = null;
    if (!locked) {
      cancel = el('button', { type: 'button', class: 'modal-cancel' }, 'Cancel');
      card.appendChild(cancel);
    }
    scrim.appendChild(card);

    function open() {
      scrim.classList.add('open');
      setTimeout(function () { userInput.focus(); }, 50);
    }
    function close() {
      if (locked) return; // the locked screen has nothing behind it to go back to
      scrim.classList.remove('open');
      input.value = '';
    }
    if (cancel) cancel.addEventListener('click', close);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      submit.disabled = true;
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: userInput.value.trim(), password: input.value }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.ok) { location.reload(); return; }
          submit.disabled = false;
          card.classList.add('modal-shake');
          sub.textContent = res.data.error || 'Incorrect username or password.';
          input.value = '';
          input.focus();
          setTimeout(function () { card.classList.remove('modal-shake'); }, 400);
        })
        .catch(function () { submit.disabled = false; sub.textContent = 'Something went wrong. Try again.'; });
    });

    return { root: scrim, open: open, close: close };
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  measureColumns();
  renderAlbumBulkAction();

  if (INITIAL_ITEM) {
    openLightbox(INITIAL_ITEM, false);
    history.replaceState({ streamItem: INITIAL_ITEM.id }, '', '/' + INITIAL_ITEM.id);
  }
  loadMore();
  fetchLibraryStatus();
})();
