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
    star: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9z"/>',
    pin: '<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6zM12 15v7"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    close: '<path d="M6 6L18 18M18 6L6 18"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.4M8.3 13.3l7.4 4.4"/>',
    download: '<path d="M12 3v11M7.5 10L12 14.5 16.5 10M5 19h14"/>',
    refresh: '<path d="M4 10a8 8 0 0114-5.3M20 5v5h-5M20 14a8 8 0 01-14 5.3M4 19v-5h5"/>',
    rss: '<circle cx="6.2" cy="17.8" r="1.6" fill="currentColor" stroke="none"/><path d="M4 10.5a9.5 9.5 0 019.5 9.5M4 4.8a15.2 15.2 0 0115.2 15.2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3 1-2h4l1 2 3 2 2 1v4l-2 1v3l2 1v4l-2 1-3 2-1 2h-4l-1-2-3-2-2-1v-4l2-1v-3l-2-1V6l2-1z"/>',
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
    chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20V7M2 20h21"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
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
    window.StreamSettings.preference(key, val);
    try { localStorage.setItem(key, val); } catch (e) { /* ignore (private browsing etc.) */ }
  }

  var randomSeed = storageGet('stream-random-seed', 'initial');
  var randomEnabled = storageGet('stream-random-enabled', '0') === '1';
  function randomLarge(id) { var n=2166136261; var value=randomSeed+id; for(var i=0;i<value.length;i++)n=Math.imul(n^value.charCodeAt(i),16777619);return (n>>>0)/4294967296<.25; }
  function refreshSizes() { grid.querySelectorAll('.tile.video-tile').forEach(function(t){if(!t.dataset.manualScale)t.classList.toggle('tile-expanded',randomEnabled?randomLarge(t.dataset.itemId):videoScale==='2');});remeasureAndReflow(); }
  function randomize() { randomSeed=window.StreamActivity.uuid();randomEnabled=true;storageSet('stream-random-seed',randomSeed);storageSet('stream-random-enabled','1');refreshSizes(); }
  function uniform() {randomEnabled=false;storageSet('stream-random-enabled','0');refreshSizes();}
  window.StreamSettings.init({randomize:randomize,uniform:uniform,theme:applyTheme,density:function(value){applyDensity(value);remeasureAndReflow();},fit:function(value){document.documentElement.dataset.mediaFit=value;storageSet('stream-media-fit',value);}});

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
  var previewSource = storageGet('stream-preview-source', 'preview');
  document.documentElement.dataset.mediaFit = storageGet('stream-media-fit', 'contain');
  var videoScale = storageGet('stream-video-scale', '1');
  var MAX_PREVIEWS = dataSaverMode ? 0 : Math.max(4, Math.min(64, Number(storageGet('stream-max-previews', '8')) || 8));
  var tileSize = Math.max(120, Math.min(460, Number(storageGet('stream-tile-size', '0')) || 0));
  if (tileSize) document.documentElement.style.setProperty('--tile-min', tileSize + 'px');

  function applyTheme(theme) {
    currentTheme = theme;
    storageSet('stream-theme', theme);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }
  function applyDensity(density) {
    currentDensity = density;
    tileSize = 0;
    document.documentElement.style.removeProperty('--tile-min');
    storageSet('stream-tile-size', '0');
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
    creator: null,
    dateField: 'created', dateFrom: null, dateTo: null, resolution: 0,
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
  var dashboardModal = buildDashboardModal();

  appEl.appendChild(header);
  appEl.appendChild(main);
  appEl.appendChild(librarySummary.root);
  appEl.appendChild(linksBottom);
  appEl.appendChild(lightbox.root);
  appEl.appendChild(signInModal.root);
  appEl.appendChild(filesModal.root);
  appEl.appendChild(dashboardModal.root);
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
      { id: 'creator', label: 'Group by creator (folder)' },
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
      { id: 'favorite', label: '★ Best / favorites' },
      { id: 'pinned', label: 'Pinned' },
      { id: 'bookmarked', label: 'Bookmarked' },
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
      storageSet('stream-data-saver', dataSaverMode ? '1' : '0');
      location.reload();
    });
    saverSection.appendChild(saverItem);
    var maxPreviewSelect = el('select', { class: 'filter-select', 'aria-label': 'Maximum simultaneous video previews' });
    [4, 8, 12, 16, 24, 64].forEach(function (number) {
      maxPreviewSelect.add(new Option(number === 64 ? 'Up to 64 video previews (high-end)' : number + ' video previews at once', String(number)));
    });
    maxPreviewSelect.value = String(MAX_PREVIEWS);
    maxPreviewSelect.addEventListener('change', function () {
      MAX_PREVIEWS = Number(maxPreviewSelect.value);
      storageSet('stream-max-previews', String(MAX_PREVIEWS));
      if (runningPreviews.size > MAX_PREVIEWS) {
        Array.from(runningPreviews).slice(MAX_PREVIEWS).forEach(pausePreview);
      }
      refillPreviews();
    });
    saverSection.appendChild(el('div', { class: 'menu-help' }, 'Simultaneously playing previews'));
    saverSection.appendChild(maxPreviewSelect);
    var sourceSelect = el('select', { class: 'filter-select', 'aria-label': 'Preview source' });
    sourceSelect.add(new Option('Optimized previews · native FPS up to 60', 'preview'));
    sourceSelect.add(new Option('Original videos · full quality / more bandwidth', 'original'));
    sourceSelect.value = previewSource;
    sourceSelect.addEventListener('change', function () { previewSource = sourceSelect.value; storageSet('stream-preview-source', previewSource); resetAndLoad(); });
    saverSection.appendChild(sourceSelect);
    var pauseAll = el('button', { class: 'menu-item' }, 'Pause / resume all previews');
    pauseAll.addEventListener('click', function () {
      autoplayEnabled = !autoplayEnabled;
      if (!autoplayEnabled) Array.from(runningPreviews).forEach(pausePreview); else refillPreviews();
      showToast(autoplayEnabled ? 'Previews playing' : 'Previews paused');
    });
    saverSection.appendChild(pauseAll);
    var fitSelect = el('select', { class: 'filter-select', 'aria-label': 'Media framing' });
    fitSelect.add(new Option('Fit entire frame · no cropping', 'contain'));
    fitSelect.add(new Option('Fill tile · crop edges', 'cover'));
    fitSelect.value = document.documentElement.dataset.mediaFit;
    fitSelect.addEventListener('change', function () { document.documentElement.dataset.mediaFit = fitSelect.value; storageSet('stream-media-fit', fitSelect.value); });
    saverSection.appendChild(fitSelect);
    if (isAdmin) {
      var rebuild = el('button', {class:'menu-item'}, 'Refresh metadata & previews');
      rebuild.addEventListener('click', function () {
        rebuild.disabled=true; showToast('Refreshing metadata and previews…');
        fetch('/api/rescan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force:true})})
          .then(function(r){if(!r.ok)throw Error('Refresh failed');return r.json();})
          .then(function(j){showToast(j.skipped?'A scan or edit is already running':'Metadata and previews refreshed');resetAndLoad();fetchLibraryStatus();})
          .catch(function(e){showToast(e.message);}).finally(function(){rebuild.disabled=false;});
      });
      saverSection.appendChild(rebuild);
    }
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

    var layoutSection = section('Tile sizing');
    var sizeCaption = el('div', { class: 'menu-help' }, 'Media width: drag to resize the grid');
    var sizeSlider = el('input', { type: 'range', min: '120', max: '460', step: '10', value: String(tileSize || 240), class: 'wide-slider', 'aria-label': 'Media tile width' });
    sizeSlider.addEventListener('input', function () {
      tileSize = Number(sizeSlider.value);
      document.documentElement.style.setProperty('--tile-min', tileSize + 'px');
      storageSet('stream-tile-size', String(tileSize));
      // One reflow per animation frame, not every intermediate pointer event.
      if (!sizeSlider._raf) sizeSlider._raf = requestAnimationFrame(function () {
        sizeSlider._raf = 0; remeasureAndReflow();
      });
    });
    layoutSection.appendChild(sizeCaption);
    layoutSection.appendChild(sizeSlider);
    ['1', '2'].forEach(function (factor) {
      var b = el('button', { class: 'menu-item', 'data-video-scale': factor }, factor === '1' ? 'Normal video tiles' : '2× video tiles');
      b.classList.toggle('selected', videoScale === factor);
      b.addEventListener('click', function () {
        videoScale = factor;
        storageSet('stream-video-scale', factor);
        Array.prototype.forEach.call(grid.querySelectorAll('.tile.video-tile'), function (t) {
          if (!t.dataset.manualScale) t.classList.toggle('tile-expanded', randomEnabled ? randomLarge(t.dataset.itemId) : videoScale === '2');
        });
        remeasureAndReflow();
        Array.prototype.forEach.call(layoutSection.querySelectorAll('[data-video-scale]'), function (button) {
          button.classList.toggle('selected', button.dataset.videoScale === factor);
        });
      });
      layoutSection.appendChild(b);
    });
    var randomButton=el('button',{class:'menu-item'},'Randomly enlarge video previews');randomButton.onclick=randomize;layoutSection.appendChild(randomButton);
    var uniformButton=el('button',{class:'menu-item'},'Turn off random enlargement');uniformButton.onclick=uniform;layoutSection.appendChild(uniformButton);
    panel.appendChild(layoutSection);

    var datesSection = section('Dates and resolution');
    var dateFieldSelect = el('select', { class: 'filter-select', 'aria-label': 'Date filter field' },
      '<option value="created">Media created/taken</option><option value="imported">Imported into Stream</option>');
    dateFieldSelect.addEventListener('change', function () { state.dateField = dateFieldSelect.value; resetAndLoad(); });
    datesSection.appendChild(dateFieldSelect);
    var from = el('input', { type: 'date', class: 'menu-date', 'aria-label': 'From date' });
    var to = el('input', { type: 'date', class: 'menu-date', 'aria-label': 'To date' });
    from.addEventListener('change', function () { state.dateFrom = from.value || null; resetAndLoad(); });
    to.addEventListener('change', function () { state.dateTo = to.value || null; resetAndLoad(); });
    datesSection.appendChild(from); datesSection.appendChild(to);
    var resolutionSelect = el('select', { class: 'filter-select', 'aria-label': 'Minimum resolution' },
      '<option value="0">Any resolution</option><option value="720">720p+</option><option value="1080">1080p+</option><option value="2160">4K+</option>');
    resolutionSelect.addEventListener('change', function () { state.resolution = Number(resolutionSelect.value); resetAndLoad(); });
    datesSection.appendChild(resolutionSelect);
    panel.appendChild(datesSection);

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

    var creatorSelect = el('select', { class: 'filter-select', 'aria-label': 'Filter by creator', style: 'display:none' });
    creatorSelect.addEventListener('change', function () {
      state.creator = creatorSelect.value || null;
      resetAndLoad();
    });
    controls.appendChild(creatorSelect);
    header._creatorSelect = creatorSelect;

    controls.appendChild(buildSearch());

    var selectBtn = el('button', { class: 'icon-btn', title: 'Select', 'aria-label': 'Select photos and videos' }, icon('checkCircle'));
    selectBtn.addEventListener('click', function () {
      if (selection.active) exitSelectionMode(); else enterSelectionMode();
    });
    controls.appendChild(selectBtn);
    header._selectBtn = selectBtn;

    controls.appendChild(buildMenu());
    var settingsButton=el('button',{class:'icon-btn',title:'Settings (/)', 'aria-label':'Settings'},icon('settings'));settingsButton.onclick=window.StreamSettings.open;controls.appendChild(settingsButton);

    var rescanBtn = el('button', { class: 'icon-btn', title: 'Rescan library', 'aria-label': 'Rescan library' }, icon('refresh'));
    rescanBtn.addEventListener('click', function () {
      rescanBtn.style.opacity = '0.4';
      fetch('/api/rescan', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('rescan failed'); return r.json(); })
        .then(function () { resetAndLoad(); fetchLibraryStatus(); showToast('Library rescanned'); })
        .catch(function () { showToast('Rescan failed'); })
        .finally(function () { rescanBtn.style.opacity = ''; });
    });
    if (isAdmin) {
      controls.appendChild(rescanBtn);
      var dashboardBtn = el('button', { class: 'icon-btn', title: 'Library dashboard', 'aria-label': 'Library dashboard' }, icon('chart'));
      dashboardBtn.addEventListener('click', function () { dashboardModal.open(); });
      controls.appendChild(dashboardBtn);
    }

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
    if (!s) return;
    if (libraryStatus.scanning) root.appendChild(el('span', { class: 'scan-timing' }, 'Scanning…'));
    root.appendChild(el('span', {}, plural(s.photoCount, 'photo')));
    root.appendChild(el('span', {}, plural(s.videoCount, 'video')));
    if (s.unsupportedCount > 0) {
      var u = el('button', { type: 'button', title: 'See which files were not imported' }, s.unsupportedCount.toLocaleString() + ' unsupported');
      u.addEventListener('click', function () { filesModal.open(); });
      root.appendChild(u);
    }
    if (s.unreadableDirectoryCount > 0) {
      var dirButton = el('button', { type: 'button', title: 'Some folders could not be read' },
        s.unreadableDirectoryCount.toLocaleString() + ' offline folders');
      dirButton.addEventListener('click', function () { filesModal.open(); });
      root.appendChild(dirButton);
    }
    if (s.failedCount > 0) {
      var f = el('button', { type: 'button', title: 'See which files could not be read' }, s.failedCount.toLocaleString() + ' unreadable');
      f.addEventListener('click', function () { filesModal.open(); });
      root.appendChild(f);
    }
    // total includes unsupported and unreadable files, so it matches what's actually in the folder
    root.appendChild(el('span', { class: 'total' }, s.total.toLocaleString() + ' total'));
    if (libraryStatus && libraryStatus.lastScan && isAdmin) {
      root.appendChild(el('span', { class: 'scan-timing' },
        'Last scan ' + (libraryStatus.lastScan.durationMs / 1000).toFixed(1) + 's'));
    }
    if (isAdmin) {
      var dashboardLink = el('button', { type: 'button', title: 'Open import statistics and scan history' }, 'Dashboard');
      dashboardLink.addEventListener('click', function () { dashboardModal.open(); });
      root.appendChild(dashboardLink);
    }
  }

  function fetchLibraryStatus() {
    var previous = libraryStatus;
    return fetch('/api/library-status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        libraryStatus = data;
        renderLibrarySummary();
        // Avoid disrupting an open lightbox or someone deep in the gallery.
        // Freshly indexed media appears automatically when the user is at the top.
        var before = previous && previous.lastScan && previous.lastScan.at;
        var after = data.lastScan && data.lastScan.at;
        if (previous && before !== after && after && !lb.open && window.scrollY < 200) resetAndLoad();
      })
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
      addSection('Unavailable directories',
        'An SMB/NAS folder could not be read. Existing records were preserved, not treated as deleted.',
        st.walkErrors || [], function (e) { return e.error; });
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

  function buildDashboardModal() {
    var scrim = el('div', { class: 'modal-scrim dashboard-scrim' });
    var card = el('section', { class: 'dashboard-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Library dashboard' });
    var head = el('div', { class: 'dashboard-head' });
    head.appendChild(el('h2', {}, 'Library audit'));
    var close = el('button', { class: 'icon-btn', 'aria-label': 'Close dashboard' }, icon('close'));
    head.appendChild(close);
    var body = el('div', { class: 'dashboard-body' });
    card.appendChild(head); card.appendChild(body); scrim.appendChild(card);
    close.addEventListener('click', function () { scrim.classList.remove('open'); });
    scrim.addEventListener('click', function (e) { if (e.target === scrim) scrim.classList.remove('open'); });

    function section(title) {
      var wrap = el('section', { class: 'dashboard-section' });
      wrap.appendChild(el('h3', {}, title)); body.appendChild(wrap); return wrap;
    }
    function barChart(title, rows, getLabel, getValue) {
      var wrap = section(title);
      var max = Math.max(1, ...rows.map(getValue));
      rows.slice(0, 25).forEach(function (row) {
        var line = el('div', { class: 'dashboard-bar-line' });
        var label = el('span', { class: 'dashboard-bar-label' }); label.textContent = getLabel(row);
        var track = el('div', { class: 'dashboard-bar-track' });
        var bar = el('div', { class: 'dashboard-bar' });
        bar.style.width = (getValue(row) / max * 100).toFixed(2) + '%';
        track.appendChild(bar);
        var val = el('span', { class: 'mono' }); val.textContent = getValue(row).toLocaleString();
        line.appendChild(label); line.appendChild(track); line.appendChild(val); wrap.appendChild(line);
      });
      if (!rows.length) wrap.appendChild(el('p', {}, 'No entries yet'));
    }
    function showAiControls() {
      var sectionEl = section('Optional AI models & hardware');
      sectionEl.appendChild(el('p', { class: 'modal-sub' },
        'Only installed models run. Downloads are explicit and optional. Hardware details reflect the container, not necessarily the physical host.'));
      var aiBox = el('div', { class: 'dashboard-ai-controls' });
      sectionEl.appendChild(aiBox);
      function render() {
        fetch('/api/ai').then(function (r) { if (!r.ok) throw Error('AI unavailable'); return r.json(); })
          .then(function (d) {
            aiBox.innerHTML = '';
            if (!d.inferenceAvailable) aiBox.appendChild(el('p', {class:'modal-sub'}, 'Downloads are available. To run detection, set STREAM_AI_STACK=true and rebuild the container.'));
            var hw = d.hardware;
            aiBox.appendChild(el('p', { class: 'dashboard-file' },
              hw.cpu + ' · ' + hw.threads + ' threads · ' + hw.detectedMemoryGiB + ' GiB visible RAM'));
            aiBox.appendChild(el('p', { class: 'dashboard-file' },
              hw.gpu.length ? hw.gpu.map(function (g) { return g.name + ' (' + g.freeVramMiB + '/' + g.totalVramMiB + ' MiB VRAM free/total)'; }).join(' · ') : hw.gpuNote));
            var modelSelect = el('select', { class: 'filter-select', 'aria-label': 'AI model' });
            d.models.forEach(function (model) {
              modelSelect.add(new Option(model.label + (model.installed ? ' · Installed' : ' · Download required'), model.id));
            });
            modelSelect.value = d.selected;
            aiBox.appendChild(modelSelect);
            var modelPath = el('p', {class:'dashboard-file'});
            function paintModelPath() {
              var model = d.models.find(function(m) {return m.id === modelSelect.value;});
              modelPath.textContent = 'Already downloaded? Place ' + model.weights + ' in ' + d.modelsDir + '. ' + model.note + '. Source: ' + model.repo + ' · ' + model.license + '. Use trusted weights only.';
            }
            paintModelPath(); modelSelect.addEventListener('change',paintModelPath); aiBox.appendChild(modelPath);
            var deviceSelect = el('select', { class: 'filter-select', 'aria-label': 'AI execution device' });
            ['auto', 'cpu', 'cuda:0'].forEach(function (v) { deviceSelect.add(new Option(v === 'auto' ? 'Auto-detect compute' : v === 'cpu' ? 'Use CPU' : 'NVIDIA GPU (CUDA:0)', v)); });
            deviceSelect.value = d.device;
            aiBox.appendChild(deviceSelect);
            var enabled = el('label', { class: 'dashboard-toggle' });
            var check = el('input', { type: 'checkbox' }); check.checked = d.enabled;
            enabled.appendChild(check);
            enabled.appendChild(el('span', {}, 'Enable selected installed model during scans'));
            aiBox.appendChild(enabled);
            var save = el('button', { class: 'dashboard-next' }, 'Save AI settings');
            save.addEventListener('click', function () {
              save.disabled = true;
              fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected: modelSelect.value, device: deviceSelect.value, enabled: check.checked }) })
                .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw Error(j.error); return j; }); })
                .then(function (saved) { showToast(saved.effective ? 'AI ready. Rescan to analyze existing media.' : 'AI preference saved; installed weights and the optional AI stack are both required.'); render(); })
                .catch(function (e) { showToast(e.message || 'Settings failed'); save.disabled = false; });
            });
            aiBox.appendChild(save);
            var selected = d.models.find(function (m) { return m.id === modelSelect.value; });
            var install = el('button', { class: 'dashboard-next' }, 'Download from Hugging Face');
            install.disabled = d.installing || (selected && selected.installed);
            install.addEventListener('click', function () {
              install.disabled = true;
              install.textContent = 'Downloading… (may take several minutes)';
              fetch('/api/ai/install', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: modelSelect.value }) })
                .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw Error(j.error); return j; }); })
                .then(function () { showToast('Model downloaded. Enable it and rescan.'); render(); })
                .catch(function (e) { showToast(e.message || 'Could not download model; check AI stack in Docker build'); render(); });
            });
            aiBox.appendChild(install);
            modelSelect.addEventListener('change', function () {
              var m = d.models.find(function (v) { return v.id === modelSelect.value; });
              install.disabled = d.installing || !m || m.installed;
            });
            aiBox.appendChild(el('p', { class: 'modal-sub' },
              'Changing models affects future rescans; existing image analysis is preserved until rescanned. GPU compute requires a CUDA-capable PyTorch install and Docker GPU passthrough.'));
          })
          .catch(function () { aiBox.textContent = 'Could not detect hardware or AI settings.'; });
      }
      render();
    }
    function showFiles() {
      var wrap = section('Indexed files (paged)');
      var list = el('div', { class: 'dashboard-files' });
      var next = el('button', { class: 'dashboard-next' }, 'Load next 100');
      var offset = 0;
      function fetchPage() {
        next.disabled = true;
        fetch('/api/dashboard/files?offset=' + offset + '&limit=100')
          .then(function (r) { if (!r.ok) throw Error('Files unavailable'); return r.json(); })
          .then(function (data) {
            data.items.forEach(function (i) {
              var line = el('div', { class: 'dashboard-file' });
              line.textContent = i.creator + ' / ' + i.filename + ' · ' + (i.width || '?') + '×' + (i.height || '?');
              list.appendChild(line);
            });
            offset += data.items.length;
            next.disabled = offset >= data.total;
            next.textContent = offset >= data.total ? 'All ' + data.total.toLocaleString() + ' indexed files shown' : 'Load next 100 (' + offset.toLocaleString() + '/' + data.total.toLocaleString() + ')';
          }).catch(function () { next.textContent = 'Could not load files'; next.disabled = false; });
      }
      next.addEventListener('click', fetchPage);
      wrap.appendChild(list); wrap.appendChild(next); fetchPage();
    }
    function open() {
      body.innerHTML = '';
      scrim.classList.add('open');
      body.appendChild(el('p', { class: 'modal-sub' }, 'Loading audit data…'));
      fetch('/api/dashboard').then(function (r) { if (!r.ok) throw Error('Dashboard unavailable'); return r.json(); })
        .then(function (d) {
          if (!scrim.classList.contains('open')) return;
          body.innerHTML = '';
          var summary = section('Overview');
          summary.appendChild(el('p', { class: 'dashboard-lead' },
            d.totals.photos.toLocaleString() + ' photos · ' + d.totals.videos.toLocaleString() +
            ' videos · ' + (d.totals.bytes / (1024 ** 3)).toFixed(2) + ' GiB indexed'));
          if (d.lastScan) summary.appendChild(el('p', { class: 'modal-sub' },
            'Last scan: ' + d.lastScan.at + ' · ' + (d.lastScan.durationMs / 1000).toFixed(1) +
            ' seconds · +' + d.lastScan.added + ' new · ' + d.lastScan.updated + ' updated · ' + d.lastScan.removed + ' removed'));
          barChart('Creators / folders', d.creators, function (x) { return x.name; }, function (x) { return x.photos + x.videos; });
          barChart('Formats', d.formats, function (x) { return x.name; }, function (x) { return x.count; });
          barChart('Resolution', d.resolutions, function (x) { return x.name; }, function (x) { return x.count; });
          var pie = section('Photos vs videos');
          var total = Math.max(1, d.totals.photos + d.totals.videos);
          var circle = el('div', { class: 'dashboard-pie', role: 'img', 'aria-label': 'Photo/video split' });
          circle.style.background = 'conic-gradient(var(--accent) 0 ' + (d.totals.photos / total * 100).toFixed(2) + '%, var(--text-muted) 0 100%)';
          pie.appendChild(circle);
          pie.appendChild(el('p', { class: 'mono' }, 'Photos ' + d.totals.photos + ' · Videos ' + d.totals.videos));
          var scans = section('Recent scans');
          (d.history || []).slice().reverse().forEach(function (scan) {
            scans.appendChild(el('div', { class: 'dashboard-file' }, scan.at + ' · ' + (scan.durationMs / 1000).toFixed(1) + 's · +' + scan.added + ' / ~' + scan.updated + ' / −' + scan.removed + ' · ' + scan.failed + ' failed'));
          });
          if (!d.history.length) scans.appendChild(el('p', {}, 'No scan history yet'));
          var errors = section('Not imported / errors');
          [].concat((d.unsupported || []).map(function (x) { return x.relPath + ': unsupported ' + x.ext; }),
            (d.failed || []).map(function (x) { return x.relPath + ': ' + x.error; }),
            (d.walkErrors || []).map(function (x) { return x.relPath + ': inaccessible folder: ' + x.error; }))
            .forEach(function (line) { errors.appendChild(el('div', { class: 'dashboard-file' }, line)); });
          if (!errors.children.length || errors.children.length === 1) errors.appendChild(el('p', {}, 'No errors in the last scan'));
          showFiles();
          showAiControls();
        }).catch(function () { body.innerHTML = ''; body.appendChild(el('p', {}, 'Could not load dashboard.')); });
    }
    return { root: scrim, open: open };
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
    var width = tile.getBoundingClientRect().width || columnWidth;
    var tileHeight = width / aspect;
    var span = Math.max(1, Math.ceil((tileHeight + gap) / (rowUnit + gap)));
    tile.style.gridRowEnd = 'span ' + span;
    // Keep the responsive <img>/<video> sizes attribute matching the
    // actual measured column width, so the browser's srcset choice is
    // based on real layout rather than a guessed vw fraction.
    var media = tile.querySelector('img.tile-media, video.tile-media');
    if (media && media.tagName === 'IMG') media.sizes = Math.round(width) + 'px';
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    cancelAnimationFrame(resizeTimer);
    resizeTimer = requestAnimationFrame(remeasureAndReflow);
  });

  function apiUrl(cursor) {
    var params = new URLSearchParams();
    if (state.type) params.set('type', state.type);
    if (state.album) params.set('album', state.album);
    if (state.creator) params.set('creator', state.creator);
    if (state.dateField) params.set('dateField', state.dateField);
    if (state.dateFrom) params.set('dateFrom', state.dateFrom);
    if (state.dateTo) params.set('dateTo', state.dateTo);
    if (state.resolution) params.set('resolution', state.resolution);
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
        updateCreatorOptions(data.creators);
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
    lastGroupCreator = null;
    inViewVideoTiles.clear();
    runningPreviews.forEach(function (tile) { pausePreview(tile); });
    runningPreviews.clear();
    state.cursor = null;
    state.done = false;
    loadMore().finally(function () { grid.classList.remove('refreshing'); });
  }

  var lastCreators = null;
  function updateCreatorOptions(creators) {
    if (!creators) return;
    var key = JSON.stringify(creators);
    if (key === lastCreators) return;
    lastCreators = key;
    var sel = header._creatorSelect;
    sel.innerHTML = '';
    sel.add(new Option('All creators', ''));
    creators.forEach(function (c) { sel.add(new Option(c, c)); });
    sel.value = state.creator || '';
    sel.style.display = creators.length ? '' : 'none';
  }

  var lastAlbums = null;
  function updateAlbumOptions(albums) {
    if (!albums) return;
    var key = JSON.stringify(albums);
    if (key === lastAlbums) return;
    lastAlbums = key;
    var sel = header._albumSelect;
    sel.innerHTML = '';
    sel.add(new Option('All albums', ''));
    albums.forEach(function (a) { sel.add(new Option(a, a)); });
    sel.value = state.album || '';
    sel.style.display = albums.length ? '' : 'none';
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

  // A dozen simultaneous 60fps decoders would make even a fast GPU stutter.
  // Prioritize hovered clips; cap others to keep the page responsive.
  var runningPreviews = new Set();
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
    video.preload = 'metadata';
    video.src = previewSource === 'original' ? item.urls.full : item.urls.preview || item.urls.full;
    video.addEventListener('error', function () { if (previewSource === 'original' && video.src.indexOf('/original') >= 0) { video.src = item.urls.preview; video.play().catch(function () {}); showToast('Original format unsupported here; using preview'); } });
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
    if (!autoplayEnabled || document.hidden || document.body.classList.contains('lb-open') || !tile.isConnected || tile._item.type !== 'video') return;
    if (runningPreviews.has(tile)) return;
    if (runningPreviews.size >= MAX_PREVIEWS) {
      // During hover, evict the oldest non-hovered playback first.
      if (!tile.matches(':hover')) return;
      var victim = Array.from(runningPreviews).find(function (t) { return !t.matches(':hover'); });
      if (!victim) victim = runningPreviews.values().next().value;
      if (victim) pausePreview(victim);
    }
    var video = attachVideoPreview(tile, tile._item);
    runningPreviews.add(tile);
    var p = video.play();
    if (p && p.catch) p.catch(function () { runningPreviews.delete(tile); });
  }
  function pausePreview(tile) {
    runningPreviews.delete(tile);
    if (tile._video) tile._video.pause();
    if (!inViewVideoTiles.has(tile) && !document.hidden) requestAnimationFrame(refillPreviews);
  }
  function refillPreviews() {
    if (document.hidden || document.body.classList.contains('lb-open')) return;
    for (var tile of inViewVideoTiles) {
      if (runningPreviews.size >= MAX_PREVIEWS) return;
      if (tile.isConnected) playPreview(tile);
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) runningPreviews.forEach(function (tile) { pausePreview(tile); });
    else Array.from(inViewVideoTiles).slice(0, MAX_PREVIEWS).forEach(playPreview);
  });

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

  var lastGroupCreator = null;
  function creatorColor(name) {
    var hash = 0;
    for (var c = 0; c < name.length; c++) hash = Math.imul(hash ^ name.charCodeAt(c), 16777619);
    return 'hsl(' + (Math.abs(hash) % 360) + ' 74% 64%)';
  }

  function addTile(item) {
    var creator = item.creator || '(Unsorted)';
    if (state.sort === 'creator' && lastGroupCreator !== creator) {
      var heading = el('li', { class: 'group-heading' });
      var dot = el('span', { class: 'creator-dot' });
      dot.style.backgroundColor = creatorColor(creator);
      heading.appendChild(dot);
      var headingText = el('span'); headingText.textContent = creator;
      heading.appendChild(headingText);
      grid.appendChild(heading);
      lastGroupCreator = creator;
    }
    var tile = el('li', { class: 'tile', tabindex: '0', role: 'button', 'aria-label': 'Open ' + item.filename, 'data-item-id': item.id });
    tile.style.background = item.color;
    tile._item = item;
    var hoverTimer;tile.addEventListener('pointerenter',function(){hoverTimer=setTimeout(function(){window.StreamActivity.record(item,'hover');},500);});tile.addEventListener('pointerleave',function(){clearTimeout(hoverTimer);});
    tile.style.setProperty('--source-color', creatorColor(creator));
    var sourceLabel = el('span', { class: 'tile-source', title: item.album || creator });
    var originName = el('strong'); originName.textContent = creator;
    sourceLabel.appendChild(originName);
    var originSub = el('small'); originSub.textContent = item.album || 'Top-level folder';
    sourceLabel.appendChild(originSub);
    tile.appendChild(sourceLabel);

    var img = el('img', { class: 'tile-media', alt: '', loading: 'lazy' });
    img.dataset.src = item.urls.thumb;
    if (item.urls.thumbSrcset) img.dataset.srcset = item.urls.thumbSrcset;
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    tile.appendChild(img);
    lazyObserver.observe(img);

    if (item.type === 'video') {
      tile.classList.add('video-tile');
      if (randomEnabled ? randomLarge(item.id) : videoScale === '2') tile.classList.add('tile-expanded');
      var expand = el('button', { type: 'button', class: 'tile-expand', title: 'Toggle large video tile', 'aria-label': 'Resize this video tile' }, icon('expand'));
      expand.addEventListener('click', function (e) {
        e.stopPropagation();
        tile.classList.toggle('tile-expanded');
        tile.dataset.manualScale = '1';
        remeasureAndReflow();
      });
      tile.appendChild(expand);
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
      var best = el('button', { class: 'tile-best', title: 'Mark as best', 'aria-label': 'Mark as best', 'aria-pressed': String(item.favorite === true) }, icon('star'));
      best.classList.toggle('active', item.favorite === true);
      best.addEventListener('click', function (e) { e.stopPropagation(); setPreference(item, 'favorite'); });
      tile.appendChild(best);
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
      if (e.target !== tile) return;
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

  function setPreference(item, key) {
    if (!item || !isAdmin) return;
    var changes = {}; changes[key] = !item[key];
    fetch('/api/items/' + encodeURIComponent(item.id) + '/preferences', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(changes)
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw Error(j.error); return j; }); })
      .then(function (data) {
        Object.assign(item, data.item);
        if (lb.item && lb.item.id === item.id) { Object.assign(lb.item, data.item); updateLightboxChrome(); renderInfoPanel(lb.item); }
        resetAndLoad(); showToast(changes[key] ? 'Saved to ' + key : 'Removed from ' + key);
      }).catch(function (e) { showToast(e.message); });
  }

  function installMediaZoom(media) {
    var scale = 1, x = 0, y = 0, points = new Map(), distance = 0;
    function paint() {
      x = Math.max(-media.clientWidth * (scale-1)/2, Math.min(media.clientWidth * (scale-1)/2, x));
      y = Math.max(-media.clientHeight * (scale-1)/2, Math.min(media.clientHeight * (scale-1)/2, y));
      media.style.setProperty('--zoom', scale); media.style.setProperty('--pan-x', x + 'px'); media.style.setProperty('--pan-y', y + 'px');
      lightbox.mediaWrap.dataset.zoomed = String(scale > 1.01);
    }
    function gap() { var a = Array.from(points.values()); return a.length === 2 ? Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y) : 0; }
    media.addEventListener('pointerdown', function (e) { if (e.pointerType === 'mouse' && scale === 1) return; points.set(e.pointerId, {x:e.clientX,y:e.clientY}); distance=gap(); if (points.size > 1 || scale > 1) media.setPointerCapture(e.pointerId); });
    media.addEventListener('pointermove', function (e) {
      var old=points.get(e.pointerId); if (!old) return;
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if (points.size === 2) { var d=gap(); if (distance) scale=Math.max(1,Math.min(5,scale*d/distance)); distance=d; }
      else if (scale > 1) { x+=e.clientX-old.x; y+=e.clientY-old.y; }
      paint();
    });
    function release(e) { points.delete(e.pointerId); distance=gap(); }
    media.addEventListener('pointerup', release); media.addEventListener('pointercancel', release);
    media.addEventListener('dblclick', function (e) { e.preventDefault(); scale=scale>1 ? 1 : 2; x=y=0; paint(); });
    media.addEventListener('wheel', function (e) { if (!e.ctrlKey) return; e.preventDefault(); scale=Math.max(1,Math.min(5,scale-e.deltaY*.01)); paint(); }, {passive:false});
  }

  function renderSavedEditor(item) {
    var box=lightbox.savedEditor; box.innerHTML=''; if (!isAdmin) return;
    box.appendChild(el('h3', {}, 'Crop & trim · Beta'));
    box.appendChild(el('p', {}, 'Save replaces this media and keeps the original in .vidstream-originals. Rotate, brightness and volume above are viewing controls only.'));
    var fields={};
    function field(key,label,value,max) {
      var wrap=el('label', {class:'edit-field'}); wrap.appendChild(el('span',{},label));
      var input=el('input',{type:'number',min:'0',step:key==='start'||key==='end'?'0.1':'1',value:String(value),'aria-label':label});
      if (max) input.max=String(max); fields[key]=input; wrap.appendChild(input); box.appendChild(wrap);
    }
    field('x','Left (pixels)',0,item.width); field('y','Top (pixels)',0,item.height);
    field('width','Crop width',item.width,item.width); field('height','Crop height',item.height,item.height);
    field('maxWidth','Output width',item.width,item.width);
    fields.width.addEventListener('input', function () { if (Number(fields.maxWidth.value)>Number(fields.width.value)) fields.maxWidth.value=fields.width.value; });
    if (item.type==='video') { field('start','Start (seconds)',0,item.duration); field('end','End (seconds)',item.duration,item.duration); }
    var preview=el('button',{class:'dashboard-next'},'Preview crop / trim');
    preview.addEventListener('click',function () {
      var media=lightbox.mediaWrap.querySelector('img,video');
      var x=Number(fields.x.value),y=Number(fields.y.value),w=Number(fields.width.value),h=Number(fields.height.value);
      var factor=Math.min(media.clientWidth/item.width,media.clientHeight/item.height);
      var mx=(media.clientWidth-item.width*factor)/2,my=(media.clientHeight-item.height*factor)/2;
      media.style.clipPath='inset('+(my+y*factor)+'px '+(mx+(item.width-x-w)*factor)+'px '+(my+(item.height-y-h)*factor)+'px '+(mx+x*factor)+'px)';
      if (fields.start) { media.currentTime=Number(fields.start.value); media.ontimeupdate=function () { if (media.currentTime>=Number(fields.end.value)) media.pause(); }; media.play().catch(function () {}); }
    });
    box.appendChild(preview);
    var message=el('p', {'aria-live':'polite'});
    var save=el('button',{class:'dashboard-next'},'Save edit & keep original');
    save.addEventListener('click',function () {
      var body={}; Object.keys(fields).forEach(function(k){body[k]=Number(fields[k].value);});
      save.disabled=true; message.textContent='Saving and rebuilding previews… You can keep browsing.';
      fetch('/api/items/'+encodeURIComponent(item.id)+'/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json().then(function(j){if(!r.ok)throw Error(j.error);return j;});})
        .then(function(j){showToast(j.warning||'Edit saved. Original archived.'); if(lb.item && lb.item.id===item.id) closeLightbox(); resetAndLoad();})
        .catch(function(e){message.textContent=e.message; save.disabled=false;});
    });
    box.appendChild(save); box.appendChild(message);
  }

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
    var preferenceButtons = {};
    [['favorite','star','Best'],['pinned','pin','Pin'],['bookmarked','bookmark','Bookmark']].forEach(function (entry) {
      var button = el('button', { class:'icon-btn', title:entry[2], 'aria-label':entry[2], style:isAdmin ? '' : 'display:none' }, icon(entry[1]));
      button.addEventListener('click', function () { setPreference(lb.item, entry[0]); });
      preferenceButtons[entry[0]] = button; actions.appendChild(button);
    });
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
    var savedEditor = el('div', { class:'saved-editor' });
    editPanel.appendChild(savedEditor);

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
      preferenceButtons: preferenceButtons, savedEditor: savedEditor,
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
    lightbox.mediaWrap.dataset.zoomed = 'false';
  }

  function applyEditState() {
    var media = lightbox.mediaWrap.querySelector('img, video');
    if (!media) return;
    media.style.setProperty('--rotation', editState.rotation + 'deg');
    media.style.setProperty('--rotation-fit', editState.rotation % 180 && lb.item ? String(Math.min(1, lightbox.mediaWrap.clientHeight / Math.max(1, media.clientWidth), lightbox.mediaWrap.clientWidth / Math.max(1, media.clientHeight))) : '1');
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
    function escapeHtml(raw) { return String(raw).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    }); }
    return '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd>';
  }

  function renderInfoPanel(item) {
    var info = item.info || {};
    var metadata = info.metadata || {};
    var cam = info.camera || {};
    var tech = info.tech || {};
    var rows = '';
    rows += infoRow('Filename', info.filename);
    rows += infoRow('Type', item.type === 'photo' ? 'Photo' + (item.isAnimated ? ' (animated)' : '') : 'Video');
    if (item.width && item.height) rows += infoRow('Dimensions', item.width + ' × ' + item.height);
    rows += infoRow('Size', formatFileSize(info.size));
    rows += infoRow('File location', info.path);
    rows += infoRow('Pixels', item.width && item.height ? (item.width * item.height / 1000000).toFixed(2) + ' megapixels' : null);
    rows += infoRow('Imported into Stream', info.addedAt ? new Date(info.addedAt).toLocaleString() : null);
    rows += infoRow('File modified', info.mtime ? new Date(info.mtime).toLocaleString() : null);
    rows += infoRow('File created', info.birthtime ? new Date(info.birthtime).toLocaleString() : null);
    rows += infoRow('Download date', 'Not recorded by most media files');
    var labels = {Make:'Device maker',Model:'Device model',Software:'Software',DateTimeOriginal:'Shot date (embedded)',CreateDate:'Created date (embedded)',GPSLatitude:'Latitude',GPSLongitude:'Longitude',GPSAltitude:'Altitude',MIMEType:'File format',scanNote:'Metadata scan'};
    Object.keys(metadata).forEach(function (key) { rows += infoRow(labels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'), metadata[key]); });
    (info.history || []).slice(0, 15).forEach(function (event) { rows += infoRow(new Date(event.at).toLocaleString(), event.action + (event.data.backup ? ' · Original: ' + event.data.backup : '')); });
    rows += infoRow('Album', info.album);
    rows += infoRow('Date', item.date ? new Date(item.date).toLocaleString() + (item.dateExact ? '' : ' (estimated)') : null);
    if (item.type === 'video') {
      rows += infoRow('Duration', item.duration ? formatDuration(item.duration) : null);
      rows += infoRow('Video codec', tech.videoCodec);
      rows += infoRow('Audio codec', tech.audioCodec);
      rows += infoRow('Preview rate', tech.previewFrameRate ? tech.previewFrameRate + ' fps' : 'Rebuild previews to update');
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
    if(isAdmin)fetch('/api/activity?item='+encodeURIComponent(item.id)).then(function(r){return r.json();}).then(function(data){if(lb.item?.id!==item.id||!data.stats)return;var stats=data.stats;lightbox.infoList.insertAdjacentHTML('beforeend',infoRow('Viewer opens',stats.opens)+infoRow('Hovers',stats.hovers)+infoRow('Plays',stats.plays)+infoRow('Watched seconds',Math.round(stats.watch_seconds)));}).catch(function(){});
  }

  var stopActivity = null;
  function renderLightboxMedia(item) {
    if(stopActivity){stopActivity();stopActivity=null;}
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
    if(item.type==='video')stopActivity=window.StreamActivity.bind(media,item);
    var previousEnhance=lightbox.root.querySelector('.enhance-video');if(previousEnhance)previousEnhance.remove();
    if(isAdmin&&item.type==='video'){var enhance=el('button',{class:'enhance-video',type:'button'},'Enhance video');enhance.onclick=function(){window.StreamSettings.enhance(item,media);};lightbox.root.querySelector('.lightbox-actions').prepend(enhance);}
    installMediaZoom(media);
    renderSavedEditor(item);
    if (bg && item.type === 'video') { bg.setHoverColor(item.color); bg.attachAudio(media); }
    lightbox.volumeGroup.style.display = item.type === 'video' ? '' : 'none';
  }

  function updateLightboxChrome() {
    Object.keys(lightbox.preferenceButtons).forEach(function (key) { var b = lightbox.preferenceButtons[key]; b.classList.toggle('active', lb.item[key] === true); b.setAttribute('aria-pressed', String(lb.item[key] === true)); });
    var digits = String(lb.total).length;
    var idx = String(lb.index + 1).padStart(digits, '0');
    var total = String(lb.total).padStart(digits, '0');
    lightbox.counter.innerHTML = idx + '<span class="sep">/</span>' + total;
    lightbox.prevBtn.disabled = !lb.prev;
    lightbox.nextBtn.disabled = !lb.next;
    lightbox.caption.textContent = lb.item.filename;
    lightbox.downloadLink.onclick=function(){window.StreamActivity.record(lb.item,'download');};
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
    if (state.creator) params.set('creator', state.creator);
    if (state.dateField) params.set('dateField', state.dateField);
    if (state.dateFrom) params.set('dateFrom', state.dateFrom);
    if (state.dateTo) params.set('dateTo', state.dateTo);
    if (state.resolution) params.set('resolution', state.resolution);
    if (state.has) params.set('has', state.has);
    if (state.q) params.set('q', state.q);
    return fetch('/api/item/' + encodeURIComponent(id) + '?' + params.toString()).then(function (r) { return r.json(); });
  }

  function openLightbox(item, fromGrid) {
    if(lb.open)window.StreamActivity.record(lb.item,'close');
    window.StreamActivity.record(item,'open');
    lb.open = true;
    if (fromGrid) lb.openedFromGrid = true; // never reset to false here — navigate() relies on this persisting across prev/next
    lb.item = item;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('lb-open');
    runningPreviews.forEach(function (tile) { pausePreview(tile); });
    lightbox.root.classList.add('open');
    renderLightboxMedia(item);
    if (fromGrid) {
      history.pushState({ streamItem: item.id }, '', '/' + item.id);
    }
    fetchNeighbors(item.id).then(function (data) {
      if (!lb.open || lb.item.id !== item.id) return;
      if (data.item) lb.item = data.item;
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
    window.StreamActivity.record(lb.item,'close');
    if(stopActivity){stopActivity();stopActivity=null;}
    lb.open = false;
    lightbox.root.classList.remove('open');
    document.body.classList.remove('lb-open');
    requestAnimationFrame(refillPreviews);
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
    if (!lb.open || document.querySelector('dialog[open]')) return;
    if (e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (e.key === 'Escape') { stopSlideshow(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { stopSlideshow(); navigate(-1); }
    else if (e.key === 'ArrowRight') { stopSlideshow(); navigate(1); }
    else if (e.key === ' ') {
      var v = lightbox.mediaWrap.querySelector('video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
  });

  var touchStartX = null, multiTouch = false;
  lightbox.root.addEventListener('touchstart', function (e) { multiTouch = e.touches.length > 1 || lightbox.mediaWrap.dataset.zoomed === 'true'; touchStartX = multiTouch ? null : e.touches[0].clientX; }, { passive: true });
  lightbox.root.addEventListener('touchend', function (e) {
    if (touchStartX === null || multiTouch || lightbox.mediaWrap.dataset.zoomed === 'true') { touchStartX = null; return; }
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
  setInterval(fetchLibraryStatus, 20000);
})();
