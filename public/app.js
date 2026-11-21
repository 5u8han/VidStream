(function () {
  'use strict';

  var appEl = document.getElementById('app');
  var CONFIG = JSON.parse(appEl.dataset.config || '{}');
  var INITIAL_ITEM = appEl.dataset.initial ? JSON.parse(appEl.dataset.initial) : null;
  var entrance = window.StreamEntrance;

  var prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canHover = matchMedia('(hover: hover)').matches;
  var dataSaverMode = (function () { try { return localStorage.getItem('stream-data-saver') === '1'; } catch (e) { return false; } })();
  var autoplayEnabled = CONFIG.videoAutoplayPreviews && !prefersReducedMotion && !dataSaverMode;
  var isAdmin = Boolean(CONFIG.isAdmin);
  var libraryStatus = null;
  var galleryRefreshSuggested = false;
  var effectsMode = storageGet('stream-effects', 'full');
  var lightweightGallery = storageGet('stream-lightweight', '0') === '1';
  var previewMemoryChoices = [[0, 'Off'], [256, '256 MiB'], [512, '512 MiB'], [1024, '1 GiB'], [2048, '2 GiB']];
  var previewMemoryMiB = Number(storageGet('stream-preview-memory-mib', storageGet('stream-preview-memory', '1') === '1' ? '1024' : '0'));
  if (!previewMemoryChoices.some(function (choice) { return choice[0] === previewMemoryMiB; })) previewMemoryMiB = 0;
  var pinnedActions=[];try{pinnedActions=JSON.parse(storageGet('stream-pinned-actions','[]'));if(!Array.isArray(pinnedActions))pinnedActions=[];}catch(_){}
  var bg = null;

  function syncEffects() {
    var mode = lightweightGallery || dataSaverMode ? 'off' : effectsMode;
    document.documentElement.dataset.effects = mode;
    document.documentElement.toggleAttribute('data-lightweight', lightweightGallery);
    if (mode !== 'full') entrance?.cancel();
    if (mode === 'off') {
      bg?.setMode(mode);
      return;
    }
    if (!bg && !prefersReducedMotion) {
      bg = window.StreamAmbient?.start({ mode: mode }) || null;
      bg?.setBusy(backgroundBusy);
    }
    bg?.setMode(mode);
  }

  syncEffects();

  if (CONFIG.locked) {
    appEl.innerHTML = '';
    var lockedModal = buildSignInModal();
    appEl.appendChild(lockedModal.root);
    window.StreamNodes?.mountLocked(appEl);
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
    download: '<path d="M12 3v11M7.5 10L12 14.5 16.5 10M5 19h14"/>',
    refresh: '<path d="M4 10a8 8 0 0114-5.3M20 5v5h-5M20 14a8 8 0 01-14 5.3M4 19v-5h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3 1-2h4l1 2 3 2 2 1v4l-2 1v3l2 1v4l-2 1-3 2-1 2h-4l-1-2-3-2-2-1v-4l2-1v-3l-2-1V6l2-1z"/>',
    sliders: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="14" cy="7" r="2" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="8" cy="12" r="2" fill="currentColor"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="16" cy="17" r="2" fill="currentColor"/>',
    play: '<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>',
    pause: '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
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
    try { localStorage.setItem(key, val); } catch (e) { }
  }

  var randomSeed = storageGet('stream-random-seed', 'initial');
  var randomEnabled = storageGet('stream-random-enabled', '0') === '1';
  function randomLarge(id) { var n=2166136261; var value=randomSeed+id; for(var i=0;i<value.length;i++)n=Math.imul(n^value.charCodeAt(i),16777619);return (n>>>0)/4294967296<.25; }
  function refreshSizes() { document.querySelectorAll('[data-video-scale]').forEach(function(b){b.classList.toggle('selected',!randomEnabled&&b.dataset.videoScale===videoScale);});document.querySelectorAll('[data-random-size]').forEach(function(b){b.classList.toggle('selected',(b.dataset.randomSize==='on')===randomEnabled);});grid.querySelectorAll('.tile.video-tile').forEach(function(t){if(!t.dataset.manualScale)t.classList.toggle('tile-expanded',randomEnabled?randomLarge(t.dataset.itemId):videoScale==='2');});remeasureAndReflow(); }
  function randomize() { randomSeed=window.StreamActivity.uuid();randomEnabled=true;storageSet('stream-random-seed',randomSeed);storageSet('stream-random-enabled','1');refreshSizes(); }
  function uniform() {randomEnabled=false;storageSet('stream-random-enabled','0');refreshSizes();}
  window.StreamSettings.init({randomize:randomize,uniform:uniform,theme:applyTheme,effects:applyEffects,density:function(value){applyDensity(value);remeasureAndReflow();},fit:function(value){document.documentElement.dataset.mediaFit=value;storageSet('stream-media-fit',value);},viewerBlur:applyViewerBlur,videoStats:setVideoStatsEnabled});


  var currentTheme = storageGet('stream-theme', CONFIG.defaultTheme || 'system');
  var currentDensity = storageGet('stream-density', 'medium');
  var previewSource = storageGet('stream-preview-source', 'preview');
  document.documentElement.dataset.mediaFit = storageGet('stream-media-fit', 'contain');
  var videoScale = '1';
  if (storageGet('stream-video-scale', '1') !== '1') storageSet('stream-video-scale', '1');
  var viewerBlur = Math.max(0, Math.min(30, Number(storageGet('stream-viewer-blur', '10')) || 0));
  var videoStatsEnabled = storageGet('stream-video-stats', '0') === '1';
  document.documentElement.style.setProperty('--viewer-blur', viewerBlur + 'px');
  var MAX_PREVIEWS = dataSaverMode ? 0 : Math.max(4, Math.min(64, Number(storageGet('stream-max-previews', '8')) || 8));
  var savedTileSize = Number(storageGet('stream-tile-size', '0'));
  var tileSize = savedTileSize > 0 ? Math.max(120, Math.min(460, savedTileSize)) : 0;
  if (tileSize) document.documentElement.style.setProperty('--tile-min', tileSize + 'px');

  function applyViewerBlur(value) {
    viewerBlur = Math.max(0, Math.min(30, Number(value) || 0));
    document.documentElement.style.setProperty('--viewer-blur', viewerBlur + 'px');
    storageSet('stream-viewer-blur', String(viewerBlur));
  }
  function applyEffects(mode) {
    var wasOff = document.documentElement.dataset.effects === 'off';
    effectsMode = mode;
    storageSet('stream-effects', mode);
    syncEffects();
    if (wasOff && bg && document.documentElement.dataset.effects !== 'off') {
      grid.querySelectorAll('.tile[data-hydrated]').forEach(function (tile) { bg.watchTile(tile, tile._item.color); });
    }
  }

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
  if (!document.documentElement.hasAttribute('data-density')) document.documentElement.setAttribute('data-density', currentDensity);

  var state = {
    folder: null,
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

  var foldersReady = Promise.resolve();


  appEl.innerHTML = '';
  var header = el('header', { class: 'header' });
  var grid = el('ul', { class: 'grid', id: 'grid' });
  var main = el('main');
  main.appendChild(grid);
  var linksBottom = el('ul', { class: 'links-bottom' });
  var lightbox = buildLightbox();
  var toastEl = el('div', { class: 'toast' });
  var librarySummary = buildLibrarySummary();
  var dashboardModal = buildDashboardModal();

  appEl.appendChild(header);
  appEl.appendChild(main);
  appEl.appendChild(librarySummary.root);
  appEl.appendChild(linksBottom);
  appEl.appendChild(lightbox.root);
  appEl.appendChild(dashboardModal.root);
  appEl.appendChild(toastEl);

  renderHeader();
  renderBottomLinks();
  entrance?.shell(header);
  window.StreamAmbient?.bindHoverFx(linksBottom);


  function buildMenu() {
    var wrap = el('div', { class: 'menu-wrap' });
    var trigger = el('button', { class: 'icon-btn control-launcher', title: 'View options', 'aria-label': 'View options', 'aria-haspopup': 'dialog', 'aria-controls': 'gallery-view-options' }, icon('sliders') + '<span>View</span>');
    var panel = el('div', { id: 'gallery-view-options', class: 'menu-panel view-panel', role: 'dialog', 'aria-label': 'View options' });
    var afterClose = null;
    header._menuPanel = panel;

    function section(label, extraClass) {
      var group = el('section', { class: 'menu-section view-section ' + (extraClass || ''), 'aria-label': label });
      group.appendChild(el('h3', { class: 'menu-label' }, label));
      return group;
    }
    function choice(label, attributes, action) {
      var button = el('button', Object.assign({ type: 'button', class: 'menu-item view-choice' }, attributes || {}));
      button.textContent = label;
      button.addEventListener('click', action);
      return button;
    }
    function selectControl(label, options, value, action) {
      var field = el('label', { class: 'view-field' });
      field.appendChild(el('span', {}, label));
      var select = el('select', { class: 'filter-select', 'aria-label': label });
      options.forEach(function (option) { select.add(new Option(option[1], option[0])); });
      select.value = String(value);
      select.addEventListener('change', function () { action(select.value); });
      field.appendChild(select);
      return { field: field, control: select };
    }
    function paintChoice(button, selected) {
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    var heading = el('header', { class: 'view-heading' });
    var title = el('div');
    title.appendChild(el('strong', {}, 'View options'));
    var close = choice('×', { class: 'view-close', 'aria-label': 'Close View options' }, function () { window.StreamNavigation.back(); });
    heading.append(title, close);
    var cards = el('div', { class: 'view-card-grid' });
    panel.append(heading, cards);

    var layout = section('Layout');
    var sizeLabel = el('label', { class: 'view-size-label', for: 'view-media-size' });
    sizeLabel.appendChild(el('span', {}, 'Media size'));
    var preferredSize = tileSize || ({ small: 160, medium: 240, large: 380 }[currentDensity] || 240);
    var sizeValue = el('output', { for: 'view-media-size', class: 'view-size-value' }, preferredSize + ' px');
    sizeLabel.appendChild(sizeValue);
    var sizeSlider = el('input', { id: 'view-media-size', type: 'range', min: '120', max: '460', step: '10', value: String(preferredSize), class: 'wide-slider', 'aria-label': 'Media size' });
    sizeSlider.addEventListener('input', function () {
      tileSize = Number(sizeSlider.value);
      sizeValue.textContent = tileSize + ' px';
      document.documentElement.style.setProperty('--tile-min', tileSize + 'px');
      storageSet('stream-tile-size', String(tileSize));
      if (!sizeSlider._raf) sizeSlider._raf = requestAnimationFrame(function () {
        sizeSlider._raf = 0; remeasureAndReflow();
      });
    });
    layout.append(sizeLabel, sizeSlider);
    cards.appendChild(layout);

    var fitChoices = el('div', { class: 'view-segmented', role: 'group', 'aria-label': 'Media framing' });
    [['contain', 'Whole frame'], ['cover', 'Fill tiles']].forEach(function (option) {
      var button = choice(option[1], { 'data-fit': option[0] }, function () {
        document.documentElement.dataset.mediaFit = option[0]; storageSet('stream-media-fit', option[0]);
        fitChoices.querySelectorAll('button').forEach(function (item) { paintChoice(item, item.dataset.fit === option[0]); });
      });
      paintChoice(button, document.documentElement.dataset.mediaFit === option[0]); fitChoices.appendChild(button);
    });
    layout.appendChild(fitChoices);
    var organicRow = el('div', { class: 'view-organic-row' });
    var randomButton = choice('Randomly enlarge videos', { 'data-random-size': 'on', 'aria-label': 'Randomly enlarge video previews' }, function () {
      if (randomEnabled) uniform(); else randomize();
      paintRandom();
    });
    var reshuffle = choice('Reshuffle', { class: 'view-text-action', 'aria-label': 'Reshuffle enlarged video previews' }, function () { randomize(); paintRandom(); });
    function paintRandom() { paintChoice(randomButton, randomEnabled); reshuffle.disabled = !randomEnabled; }
    paintRandom(); organicRow.append(randomButton, reshuffle); layout.appendChild(organicRow);

    var outlines = section('Artist outlines');
    var outlineChoices = el('div', { class: 'view-segmented', role: 'group', 'aria-label': 'Artist outlines' });
    [['off', 'Off'], ['subtle', 'Fine borders'], ['hover', 'On hover']].forEach(function (option) {
      var button = choice(option[1], { 'data-artist-outlines': option[0] }, function () {
        storageSet('stream-artist-outlines', option[0]); artistOutlines.setMode(option[0]); updateArtistSpacing(option[0]);
        outlineChoices.querySelectorAll('button').forEach(function (item) { paintChoice(item, item.dataset.artistOutlines === option[0]); });
      });
      paintChoice(button, storageGet('stream-artist-outlines', 'off') === option[0]); outlineChoices.appendChild(button);
    });
    var recolor = choice('Shuffle colors', { class: 'view-text-action', 'aria-label': 'Shuffle artist colors' }, function () {
      storageSet('stream-artist-palette', window.StreamActivity.uuid());
      grid.querySelectorAll('.tile').forEach(function (tile) { tile.style.setProperty('--source-color', creatorColor(tile._item.creator)); }); artistOutlines.refresh();
    });
    outlines.append(outlineChoices, recolor); cards.appendChild(outlines);

    var filters = section('Sorting and filters');
    var sortOptions = [['desc', 'Newest first'], ['asc', 'Oldest first'], ['name-asc', 'Name A–Z'], ['name-desc', 'Name Z–A'], ['random', 'Shuffle'], ['creator', 'All media · artist A–Z']];
    if (isAdmin) sortOptions.push(['recent', 'Recently opened'], ['continue', 'Continue watching'], ['less-seen', 'Less-seen shuffle']);
    function chooseSort(value) {
      if (value === 'random' || value === 'less-seen') state.seed = String(Date.now());
      if (value === 'continue') { state.type = 'video'; header.querySelector('[aria-label="Filter by type"]').value = 'video'; }
      if (value === 'creator') clearGalleryFilters();
      state.sort = value; markSortSelected(); resetAndLoad();
    }
    var order = selectControl('Sort order', sortOptions, state.sort, chooseSort);
    if (CONFIG.allowOrderSortChange) filters.appendChild(order.field);
    var containsChoices = el('div', { class: 'view-filter-choices' });
    [['', 'All media'], ['favorite', '★ Favorites'], ['pinned', 'Pinned'], ['bookmarked', 'Bookmarks'], ['face', 'Faces'], ['cat', 'Pets'], ['text', 'Text']].forEach(function (option) {
      var button = choice(option[1], { 'data-has': option[0] }, function () {
        state.has = option[0] || null; refreshContainsHighlight(); resetAndLoad();
      });
      paintChoice(button, (state.has || '') === option[0]); containsChoices.appendChild(button);
    });
    containsChoices.setAttribute('role', 'group');
    containsChoices.setAttribute('aria-label', 'Show only');
    filters.appendChild(containsChoices);
    header._containsSection = containsChoices;

    var previews = section('Video previews', 'view-preview-section');
    var pauseAll = choice('Autoplay previews', { 'data-preview-toggle': '1' }, function () {
      autoplayEnabled = !autoplayEnabled;
      if (!autoplayEnabled) Array.from(runningPreviews).forEach(pausePreview); else refillPreviews();
      paintPreviews(); showToast(autoplayEnabled ? 'Previews playing' : 'Previews paused');
    });
    var previewState = el('span', { class: 'view-value' });
    pauseAll.appendChild(previewState);
    function paintPreviews() { paintChoice(pauseAll, autoplayEnabled); previewState.textContent = autoplayEnabled ? 'Playing' : 'Paused'; }
    var lite = choice('Lightweight gallery', { 'aria-describedby': 'lightweight-gallery-help' }, function () {
      lightweightGallery = !lightweightGallery;
      storageSet('stream-lightweight', lightweightGallery ? '1' : '0');
      syncEffects();
      previewController.clear();
      grid.querySelectorAll('.tile[data-hydrated]').forEach(function (tile) {
        dehydrateTile(tile, true);
        hydrateTile(tile);
      });
      paintLightweight();
    });
    function paintLightweight() {
      paintChoice(lite, lightweightGallery);
      source.control.disabled = lightweightGallery;
      source.control.value = currentPreviewSource();
    }
    var liteHelp = el('p', { id: 'lightweight-gallery-help', class: 'menu-help' }, 'Smaller thumbnails and lighter effects. Autoplay stays available.');
    var previewChoices = el('div', { class: 'view-action-row' });
    paintPreviews(); previewChoices.append(pauseAll, lite); previews.append(previewChoices, liteHelp);

    var dates = section('Dates and resolution');
    var dateField = selectControl('Date filter field', [['created', 'Media created/taken'], ['imported', 'Imported into Stream']], state.dateField, function (value) { state.dateField = value; resetAndLoad(); });
    var from = el('input', { type: 'date', class: 'menu-date', 'aria-label': 'From date', value: state.dateFrom || '' });
    var to = el('input', { type: 'date', class: 'menu-date', 'aria-label': 'To date', value: state.dateTo || '' });
    from.addEventListener('change', function () { state.dateFrom = from.value || null; resetAndLoad(); });
    to.addEventListener('change', function () { state.dateTo = to.value || null; resetAndLoad(); });
    var dateRange = el('div', { class: 'view-date-range' });
    var fromLabel = el('label', { class: 'view-field' }); fromLabel.append(el('span', {}, 'From'), from);
    var toLabel = el('label', { class: 'view-field' }); toLabel.append(el('span', {}, 'To'), to);
    dateRange.append(fromLabel, toLabel);
    var resolution = selectControl('Minimum resolution', [['0', 'Any resolution'], ['720', '720p+'], ['1080', '1080p+'], ['2160', '4K+']], state.resolution, function (value) { state.resolution = Number(value); resetAndLoad(); });
    dates.append(dateField.field, dateRange, resolution.field);
    cards.append(filters, dates, previews);

    var playback = previews;
    var maxPreview = selectControl('Concurrent previews', [[4, '4 previews'], [8, '8 previews'], [12, '12 previews'], [16, '16 previews'], [24, '24 previews'], [64, 'Up to 64 previews']], MAX_PREVIEWS || 8, function (value) {
      MAX_PREVIEWS = Number(value); storageSet('stream-max-previews', String(MAX_PREVIEWS));
      if (runningPreviews.size > MAX_PREVIEWS) Array.from(runningPreviews).slice(MAX_PREVIEWS).forEach(pausePreview);
      previewController.trim();
      refillPreviews();
    });
    var source = selectControl('Preview source', [['preview', 'Optimized · native FPS up to 60'], ['original', 'Original · full quality']], previewSource, function (value) { previewSource = value; storageSet('stream-preview-source', value); resetAndLoad(); });
    paintLightweight();
    var saver = choice('Data saver', { 'data-saver-toggle': '1', title: 'Reduces autoplay and loads images later. Reloads this page.' }, function () {
      dataSaverMode = !dataSaverMode; storageSet('stream-data-saver', dataSaverMode ? '1' : '0'); location.reload();
    });
    paintChoice(saver, dataSaverMode);
    var memory = selectControl('Browser preview memory', previewMemoryChoices, previewMemoryMiB, function (value) {
      previewMemoryMiB = Number(value);
      storageSet('stream-preview-memory-mib', value);
      previewMemory.setBudget(previewMemoryMiB * 1024 ** 2);
    });
    memory.control.setAttribute('aria-describedby', 'preview-memory-help');
    var memoryHelp = el('p', { id: 'preview-memory-help', class: 'menu-help' }, 'Keep recently played optimized clips in this tab. Choose a larger budget on devices with spare memory.');
    var diagnose = choice('Check playback smoothness', {}, function () {
      window.StreamNavigation.leave('options');
      window.StreamDiagnostics.open({
        videos: function () { return Array.from(runningPreviews).map(function (tile) { return tile._video; }).filter(Boolean).slice(0, 4); },
        previewLimit: MAX_PREVIEWS,
        previewStats: function () {
          return Object.assign(previewController.stats(), { tabMemory: Object.assign({ enabled: previewMemoryMiB > 0 }, previewMemory.stats()) });
        },
        effects: document.documentElement.dataset.effects,
        lightweight: lightweightGallery,
        previewSource: currentPreviewSource()
      });
    });
    var playbackControls = el('div', { class: 'view-date-range' });
    playbackControls.append(source.field, maxPreview.field, memory.field);
    var playbackActions = el('div', { class: 'view-action-row' });
    playbackActions.append(saver, diagnose);
    playback.append(playbackControls, playbackActions, memoryHelp);
    if (isAdmin) {
      var rebuild = choice('Refresh metadata & previews', {}, function () {
        queueLibraryScan(rebuild, true);
      });
      playbackActions.appendChild(rebuild);
    }

    var saved = section('Saved views');
    var viewName = el('input', { type: 'text', class: 'menu-date', maxlength: '50', placeholder: 'Name this view', 'aria-label': 'Saved view name' });
    var savedSelect = el('select', { class: 'filter-select', 'aria-label': 'Saved views' });
    var savedViews = []; try { savedViews = JSON.parse(storageGet('stream-saved-filters', '[]')); if (!Array.isArray(savedViews)) savedViews = []; } catch (_) {}
    savedViews = savedViews.slice(0, 20).filter(function (view) { return view && typeof view.name === 'string' && view.filters && typeof view.filters === 'object'; });
    var savedKeys = ['type', 'album', 'creator', 'dateField', 'dateFrom', 'dateTo', 'resolution', 'has', 'q', 'sort', 'seed'];
    function paintSaved() { savedSelect.replaceChildren(new Option('Choose a saved view', '')); savedViews.forEach(function (view, index) { savedSelect.add(new Option(view.name, String(index))); }); }
    savedSelect.addEventListener('change', function () {
      if (savedSelect.value === '') return; var view = savedViews[Number(savedSelect.value)]; if (!view) return;
      savedKeys.forEach(function (key) { if (Object.hasOwn(view.filters, key)) state[key] = view.filters[key]; });
      header._albumSelect.value = state.album || ''; header._creatorSelect.value = state.creator || '';
      header.querySelector('[aria-label="Filter by type"]').value = state.type || '';
      var search = header.querySelector('input[type=search]'); if (search) search.value = state.q || '';
      from.value = state.dateFrom || ''; to.value = state.dateTo || ''; dateField.control.value = state.dateField || 'created'; resolution.control.value = String(state.resolution || 0);
      markSortSelected(); refreshContainsHighlight(); resetAndLoad(); showToast('Saved view applied');
    });
    var saveView = choice('Save', {}, function () {
      var name = viewName.value.trim(); if (!name) { viewName.focus(); return; }
      var filters = {}; savedKeys.forEach(function (key) { filters[key] = state[key]; });
      savedViews = savedViews.filter(function (view) { return view.name !== name; }); savedViews.unshift({ name: name, filters: filters }); savedViews = savedViews.slice(0, 20);
      storageSet('stream-saved-filters', JSON.stringify(savedViews)); paintSaved(); showToast('View saved on this browser');
    });
    var removeView = choice('Remove', { 'aria-label': 'Remove selected saved view' }, function () {
      if (savedSelect.value === '') return; savedViews.splice(Number(savedSelect.value), 1); storageSet('stream-saved-filters', JSON.stringify(savedViews)); paintSaved();
    });
    var savedFields = el('div', { class: 'view-saved-fields' });
    savedFields.append(viewName, saveView, savedSelect, removeView);
    saved.appendChild(savedFields); cards.appendChild(saved); paintSaved();

    var quick = section('Pin to toolbar');
    var pins = el('div', { class: 'view-action-row' });
    quick.appendChild(pins);
    [['shuffle', 'Shuffle'], ['best', 'Favorites'], ['previews', 'Pause previews']].forEach(function (entry) {
      var button = choice(entry[1], { 'aria-label': 'Pin ' + entry[1] + ' to toolbar' }, function () {
        var index = pinnedActions.indexOf(entry[0]); if (index < 0) pinnedActions.push(entry[0]); else pinnedActions.splice(index, 1);
        storageSet('stream-pinned-actions', JSON.stringify(pinnedActions)); paintChoice(button, pinnedActions.includes(entry[0])); renderQuickActions();
      });
      paintChoice(button, pinnedActions.includes(entry[0])); pins.appendChild(button);
    });
    cards.appendChild(quick);

    function markSortSelected() {
      order.control.value = state.sort;
    }
    markSortSelected(); refreshContainsHighlight();

    function positionPanel() {
      var anchor = trigger.getBoundingClientRect();
      var width = Math.min(innerWidth <= 900 ? 670 : 880, innerWidth - 16);
      var left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - 8));
      panel.style.setProperty('--controls-top', Math.max(8, header.getBoundingClientRect().bottom + 8) + 'px');
      panel.style.setProperty('--controls-left', left + 'px');
    }
    function showMenu() {
      panel.hidden = false; positionPanel(); panel.classList.add('open'); panel.inert = false;
      trigger.setAttribute('aria-expanded', 'true'); markSortSelected(); paintPreviews(); paintRandom();
      document.addEventListener('click', outsideClick, true);
      window.addEventListener('resize', positionPanel);
    }
    function hideMenu() {
      panel.classList.remove('open'); panel.hidden = true; panel.inert = true; trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outsideClick, true);
      window.removeEventListener('resize', positionPanel);
      trigger.focus({ preventScroll: true });
      if (afterClose) {
        var next = afterClose; afterClose = null;
        queueMicrotask(function () { if (next.isConnected) { next.focus({ preventScroll: true }); next.click(); } });
      }
    }
    function openMenu() {
      if (!window.StreamNavigation.enter('options', { back: hideMenu, forward: showMenu })) return;
      showMenu(); sizeSlider.focus({ preventScroll: true });
    }
    function outsideClick(event) {
      if (!wrap.contains(event.target)) {
        afterClose = event.target.closest('.header button');
        event.preventDefault(); event.stopImmediatePropagation(); window.StreamNavigation.back();
      }
    }
    trigger.addEventListener('click', function (event) {
      event.stopPropagation(); if (panel.classList.contains('open')) window.StreamNavigation.back(); else openMenu();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panel.classList.contains('open') && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation(); window.StreamNavigation.back();
      }
    }, true);
    panel.hidden = true; panel.inert = true; trigger.setAttribute('aria-expanded', 'false'); wrap.append(trigger, panel);
    return wrap;
  }

  function clearGalleryFilters(){
    state.type=state.album=state.creator=state.has=state.dateFrom=state.dateTo=null;state.q='';state.resolution=0;
    if(header._albumSelect)header._albumSelect.value='';if(header._creatorSelect)header._creatorSelect.value='';
    header.querySelectorAll('input[type="date"]').forEach(function(input){input.value='';});
    header.querySelector('[aria-label="Filter by type"]').value='';
    header.querySelector('[aria-label="Minimum resolution"]').value='0';
    var search=header.querySelector('input[type="search"]');if(search)search.value='';refreshContainsHighlight();
  }
  function remeasureAndReflow() {
    measureColumns();
    Array.prototype.forEach.call(grid.querySelectorAll('.tile'), function (tile) {
      if (tile._item) applySpan(tile, tile._item);
    });
    if(artistOutlines)artistOutlines.refresh();
  }


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


  function renderHeader() {
    var title = el('div', { class: 'header-title' });
    title.textContent = 'Folders';

    var controls = el('div', { class: 'header-controls' });
    header._quickActions=el('div',{class:'quick-actions','aria-label':'Pinned quick actions'});controls.appendChild(header._quickActions);renderQuickActions();

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

    controls.appendChild(buildMenu());
    var settingsButton=el('button',{class:'icon-btn control-launcher',title:'Settings (/)', 'aria-label':'Settings', 'aria-haspopup':'dialog', 'aria-controls':'stream-settings', 'aria-expanded':'false'},icon('settings')+'<span>Settings</span>');settingsButton.onclick=window.StreamSettings.open;controls.appendChild(settingsButton);

    var rescanBtn = el('button', { class: 'icon-btn', title: 'Rescan library', 'aria-label': 'Rescan library' }, icon('refresh'));
    rescanBtn.addEventListener('click', function () { queueLibraryScan(rescanBtn, false); });
    if (isAdmin) {
      controls.appendChild(rescanBtn);
      var dashboardBtn = el('button', { class: 'icon-btn header-dashboard', title: 'Library dashboard', 'aria-label': 'Library dashboard' }, icon('chart'));
      dashboardBtn.appendChild(el('span', { class: 'dashboard-issue-badge', 'data-issue-count': '', hidden: '' }));
      dashboardBtn.addEventListener('click', function () { dashboardModal.open(); });
      controls.appendChild(dashboardBtn);
    }

    header.appendChild(title);
    header.appendChild(controls);
    if (window.StreamFolders) foldersReady = window.StreamFolders.mount(title, INITIAL_ITEM ? INITIAL_ITEM.album || '' : undefined);
    window.StreamNodes?.mount(header);
  }


  function renderQuickActions() {
    if(!header._quickActions)return;header._quickActions.replaceChildren();
    [['shuffle','Shuffle'],['best','Best'],['previews','Pause / resume previews']].forEach(function(entry){
      if(!pinnedActions.includes(entry[0]))return;var button=el('button',{type:'button',class:'quick-action'},entry[1]);
      button.onclick=function(){if(entry[0]==='shuffle'){state.sort='random';state.seed=String(Date.now());resetAndLoad();}else if(entry[0]==='best'){state.has=state.has==='favorite'?null:'favorite';refreshContainsHighlight();resetAndLoad();}else{autoplayEnabled=!autoplayEnabled;if(!autoplayEnabled)Array.from(runningPreviews).forEach(pausePreview);else refillPreviews();showToast(autoplayEnabled?'Previews playing':'Previews paused');}};
      header._quickActions.appendChild(button);
    });
  }

  function plural(n, word) { return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's'); }

  function buildLibrarySummary() {
    return { root: el('div', { class: 'library-summary mono' }) };
  }

  function renderLibrarySummary() {
    var s = libraryStatus && libraryStatus.stats;
    var root = librarySummary.root;
    if (root.classList.contains('video-stats')) return;
    root.innerHTML = '';
    if (!s) return;
    if (libraryStatus.scanning || libraryStatus.queued?.length) {
      var scanButton = el('button', { type: 'button', class: 'scan-timing', title: 'Open live scan activity' }, scanDescription(libraryStatus));
      scanButton.addEventListener('click', function () { dashboardModal.open('scan'); });
      root.appendChild(scanButton);
    }
    root.appendChild(el('span', {}, plural(s.photoCount, 'photo')));
    root.appendChild(el('span', {}, plural(s.videoCount, 'video')));
    if (s.unsupportedCount > 0) {
      var u = el('button', { type: 'button', title: 'See which files were not imported' }, s.unsupportedCount.toLocaleString() + ' unsupported');
      u.addEventListener('click', function () { dashboardModal.open('issues'); });
      root.appendChild(u);
    }
    if (s.unreadableDirectoryCount > 0) {
      var dirButton = el('button', { type: 'button', title: 'Some folders could not be read' },
        s.unreadableDirectoryCount.toLocaleString() + ' offline folders');
      dirButton.addEventListener('click', function () { dashboardModal.open('issues'); });
      root.appendChild(dirButton);
    }
    if (s.failedCount > 0) {
      var f = el('button', { type: 'button', title: 'See which files could not be read' }, s.failedCount.toLocaleString() + ' unreadable');
      f.addEventListener('click', function () { dashboardModal.open('repairs'); });
      root.appendChild(f);
    }
    root.appendChild(el('span', { class: 'total' }, s.total.toLocaleString() + ' total'));
    if (libraryStatus && libraryStatus.lastScan && isAdmin) {
      root.appendChild(el('span', { class: 'scan-timing' },
        'Last scan ' + (libraryStatus.lastScan.durationMs / 1000).toFixed(1) + 's'));
    }
    if (galleryRefreshSuggested) {
      var refresh = el('button', { type: 'button' }, 'Refresh gallery');
      refresh.addEventListener('click', function () { resetAndLoad(); });
      root.appendChild(refresh);
    }
    if (isAdmin) {
      var dashboardLink = el('button', { type: 'button', title: 'Open import statistics and scan history' }, 'Dashboard');
      dashboardLink.addEventListener('click', function () { dashboardModal.open(); });
      root.appendChild(dashboardLink);
    }
  }

  var stopStatsSampling = null;
  function renderVideoStats(sample) {
    var root = librarySummary.root;
    var video = lightbox.mediaWrap.querySelector('video');
    if (!lb.open || !videoStatsEnabled || !video || !lb.item) return;
    var tech = lb.item.info?.tech || {};
    var compatible = video.dataset.sourceKind === 'compatible';
    var sourceFps = tech.frameRate;
    var dimensions = sample.width && sample.height ? sample.width + '×' + sample.height : 'loading';
    var viewport = Math.round(video.clientWidth) + '×' + Math.round(video.clientHeight);
    var values = ['Stats for nerds', dimensions + ' source · ' + viewport + ' viewport',
      (sourceFps ? Number(sourceFps).toFixed(2) + ' source fps · ' : '') + (sample.fps === null ? 'fps pending / inactive' : sample.fps.toFixed(1) + ' ' + sample.fpsKind + ' fps'),
      sample.total === null || sample.dropped === null ? 'Frame counters unavailable' : sample.dropped.toLocaleString() + ' dropped / ' + sample.total.toLocaleString() + ' frames',
      sample.bufferedSeconds.toFixed(1) + 's buffered · ' + sample.rate.toFixed(2) + '× · ' + sample.state,
      compatible ? 'Compatible copy · H.264' : [tech.videoCodec, tech.audioCodec, 'Original'].filter(Boolean).join(' · ')];
    if (!root._statsFields) {
      root._statsFields = values.map(function (_, i) { return el(i ? 'span' : 'strong'); });
      var hide = el('button', { type: 'button' }, 'Hide stats'); hide.onclick = function () { lightbox.statsBtn.focus(); setVideoStatsEnabled(false); };
      root.replaceChildren.apply(root, root._statsFields.concat(hide));
    }
    values.forEach(function (value, i) { root._statsFields[i].textContent = value; });
  }
  function stopVideoStats() {
    if (stopStatsSampling) { stopStatsSampling(); stopStatsSampling = null; }
    lightbox.statsBtn.classList.remove('active');
    lightbox.statsBtn.setAttribute('aria-pressed', 'false');
    librarySummary.root.classList.remove('video-stats');
    delete librarySummary.root._statsFields;
    appEl.insertBefore(librarySummary.root, linksBottom);
    renderLibrarySummary();
  }
  function startVideoStats() {
    if (stopStatsSampling) { stopStatsSampling(); stopStatsSampling = null; }
    var video = lightbox.mediaWrap.querySelector('video');
    var active = Boolean(lb.open && videoStatsEnabled && video);
    lightbox.statsBtn.classList.toggle('active', active);
    lightbox.statsBtn.setAttribute('aria-pressed', String(active));
    if (!active) { stopVideoStats(); return; }
    librarySummary.root.classList.add('video-stats');
    lightbox.card.appendChild(librarySummary.root);
    stopStatsSampling = window.StreamPlayerStats.start(video, renderVideoStats);
  }
  function setVideoStatsEnabled(enabled) {
    videoStatsEnabled = Boolean(enabled);
    storageSet('stream-video-stats', videoStatsEnabled ? '1' : '0');
    if (videoStatsEnabled) startVideoStats(); else stopVideoStats();
  }

  function scanDescription(data) {
    var progress = data.progress;
    if (!progress) return data.queued?.length ? 'Scan queued' : data.scanning ? 'Starting scan…' : 'No scan running';
    var names = { discovering: 'Discovering', checking: 'Checking', processing: 'Importing', reconciling: 'Reconciling' };
    var phase = names[progress.phase] || 'Scanning';
    var count = function (n) { return Number(n || 0).toLocaleString(); };
    if (progress.pauseState === 'paused') phase = 'Paused · ' + phase;
    if (progress.pauseState === 'pausing') phase = 'Pausing · ' + phase;
    if (progress.folder) phase += ' ' + progress.folder;
    if (progress.phase === 'discovering') return phase + ' · ' + count(progress.discovered) + ' media found';
    if (progress.phase === 'checking') return phase + ' · ' + count(progress.examined) + ' / ' + count(progress.discovered) + ' checked';
    if (progress.phase === 'processing') return phase + ' · ' + count(progress.processed) + ' / ' + count(progress.discovered) + ' processed';
    if (progress.phase === 'reconciling') return phase + ' · ' + count(progress.reconciled) + ' checked';
    return phase;
  }

  var libraryStatusRequest;
  function fetchLibraryStatus() {
    if (libraryStatusRequest || document.hidden) return libraryStatusRequest;
    var previous = libraryStatus;
    libraryStatusRequest = fetch('/api/library-status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        libraryStatus = data;
        window.StreamFolders?.updateScanStatus(data);
        var activePath = window.StreamFolders?.selectedPath() || '';
        var scannedPath = data.lastScan?.folder;
        var relevant = !activePath || !scannedPath || activePath === scannedPath ||
          activePath.startsWith(scannedPath + '/') || scannedPath.startsWith(activePath + '/');
        var finished = previous && data.lastScan?.at && previous.lastScan?.at !== data.lastScan.at && relevant;
        var hasTiles = Boolean(grid.querySelector('.tile'));
        var progress = data.progress;
        var importingHere = !activePath || !progress?.folder || progress.folder === activePath ||
          activePath.startsWith(progress.folder + '/') || progress.folder.startsWith(activePath + '/');
        var firstItemsReady = data.scanning && importingHere && progress?.processed > 0 &&
          progress.processed !== previous?.progress?.processed && state.loadedOnce && !state.loading && !hasTiles;
        if (!lb.open && !restoreTask && !document.hidden && (firstItemsReady || (finished && !hasTiles))) resetAndLoad();
        if (finished && hasTiles && (data.lastScan.added || data.lastScan.updated || data.lastScan.removed)) galleryRefreshSuggested = true;
        renderLibrarySummary();
      })
      .catch(function () { })
      .finally(function () { libraryStatusRequest = null; });
    return libraryStatusRequest;
  }

  async function queueLibraryScan(button, force, folder) {
    button.disabled = true;
    try {
      var response = await fetch('/api/rescan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: force, folder: folder || undefined })
      });
      var result = await response.json();
      if (!response.ok) throw Error(result.error || result.reason || 'Scan could not start.');
      showToast(result.queued ? 'Library scan queued' : 'Library scan started');
      fetchLibraryStatus();
      return true;
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  function refreshPendingPreviews() {
    if (currentPreviewSource() !== 'preview' || !autoplayEnabled || dataSaverMode || document.hidden || lb.open) return;
    var pending = new Map(), params = new URLSearchParams();
    for (var tile of inViewVideoTiles) {
      var item = tile._item;
      if (!item.urls.preview && item.processing?.stage !== 'failed') {
        pending.set(item.id, item);
        params.append('id', item.id);
        if (pending.size === 64) break;
      }
    }
    if (!pending.size) return;
    return fetch('/api/ready-previews?' + params)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data) return;
        data.previews.forEach(function (preview) {
          var item = pending.get(preview.id);
          if (item && !item.urls.preview) item.urls.preview = preview.url;
        });
        previewController.refill();
      })
      .catch(function () {});
  }

  function buildDashboardModal() {
    var scrim = el('div', { class: 'modal-scrim dashboard-scrim' });
    scrim.inert = true;
    scrim.setAttribute('aria-hidden', 'true');
    var card = el('section', { class: 'dashboard-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Library dashboard' });
    var head = el('div', { class: 'dashboard-head' });
    var back = el('button', { type: 'button', class: 'dashboard-back', hidden: true });
    head.appendChild(back);
    head.appendChild(el('h2', {}, 'Dashboard'));
    var notifications = window.StreamDashboardNotifications.mount(head, { openItem: openItem });
    function openItem(itemId) {
      dismiss(function () {
        fetch('/api/item/' + encodeURIComponent(itemId)).then(function (r) {
          if (!r.ok) throw Error('Media unavailable');
          return r.json();
        }).then(function (data) { if (data.item) openLightbox(data.item, true); })
          .catch(function (error) { showToast(error.message); });
      });
    }
    var close = el('button', { class: 'icon-btn', 'aria-label': 'Close dashboard' }, icon('close'));
    head.appendChild(close);
    var body = el('div', { class: 'dashboard-body' });
    card.appendChild(head); card.appendChild(body); scrim.appendChild(card);
    var repairs = window.StreamDashboardNotifications.mountRepairs(card, { openItem: openItem, openRepair: openRepair });
    var navigation = window.StreamNavigation;
    var pendingDismiss;
    var refreshTimer, openId = 0, returnFocus, benchmarkPanel, folderMapView;
    function setBackLabel(label) {
      back.hidden = !label;
      back.textContent = label ? '‹ ' + label : '';
      head.querySelector('.dashboard-issues-toggle').hidden = Boolean(label);
      head.classList.toggle('dashboard-head-nested', Boolean(label));
    }
    function openRepairs(origin, issueId) {
      function show() {
        if (!scrim.classList.contains('open')) return false;
        notifications.close();
        body.hidden = true;
        setBackLabel('Dashboard');
        repairs.open();
        return true;
      }
      function hide() {
        repairs.close();
        body.hidden = false;
        setBackLabel(null);
        if (pendingDismiss) {
          var finish = pendingDismiss;
          pendingDismiss = null;
          finish();
        } else (origin?.isConnected ? origin : close).focus({ preventScroll: true });
      }
      if (!navigation.enter('dashboard-repairs', { back: hide, forward: show })) return;
      show();
      if (issueId) openRepair(issueId);
    }
    function openRepair(issueId, origin) {
      function show() {
        if (!scrim.classList.contains('open')) return false;
        setBackLabel('Media repairs');
        void repairs.showDetail(issueId);
        return true;
      }
      function hide() {
        if (pendingDismiss) return;
        setBackLabel('Dashboard');
        repairs.showList(origin);
      }
      if (navigation.enter('dashboard-repair', { back: hide, forward: show })) show();
    }
    function dismiss(afterClose) {
      if (!scrim.classList.contains('open')) return;
      function finish() {
        openId++;
        clearTimeout(refreshTimer);
        notifications.close();
        repairs.close();
        benchmarkPanel?.dispose();
        folderMapView?.dispose();
        scrim.classList.remove('open');
        scrim.inert = true;
        scrim.setAttribute('aria-hidden', 'true');
        returnFocus?.focus({ preventScroll: true });
        afterClose?.();
      }
      if (navigation.has('dashboard-repairs')) {
        if (navigation.leave('dashboard-repairs')) pendingDismiss = finish;
      } else finish();
    }
    close.addEventListener('click', function () { dismiss(); });
    back.addEventListener('click', function () { navigation.back(); });
    scrim.addEventListener('click', function (e) { if (e.target === scrim) dismiss(); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        var controls = Array.from(card.querySelectorAll('a[href],button,select,input,textarea,summary,[tabindex="0"]'))
          .filter(function (control) { return !control.disabled && !control.closest('[hidden],[inert]') && control.getClientRects().length; });
        var first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!back.hidden) navigation.back();
      else if (notifications.isOpen()) {
        notifications.close();
        head.querySelector('.dashboard-issues-toggle').focus({ preventScroll: true });
      } else dismiss();
    });

    function section(title) {
      var wrap = el('section', { class: 'dashboard-section' });
      wrap.appendChild(el('h3', {}, title)); body.appendChild(wrap); return wrap;
    }
    function barChart(title, rows, getLabel, getValue) {
      var wrap = section(title);
      var top = rows.slice(0, 25);
      var max = Math.max(1, ...top.map(getValue));
      top.forEach(function (row) {
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
      var sectionEl = section('Optional object recognition');
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
      var next = el('button', { class: 'dashboard-next' }, 'Load indexed files');
      var offset = 0;
      function fetchPage() {
        next.disabled = true;
        fetch('/api/dashboard/files?offset=' + offset + '&limit=100')
          .then(function (r) { if (!r.ok) throw Error('Files unavailable'); return r.json(); })
          .then(function (data) {
            if (!wrap.isConnected) return;
            data.items.forEach(function (i) {
              var line = el('div', { class: 'dashboard-file' });
              line.textContent = (i.displayCreator || i.creator) + ' / ' + i.filename + ' · ' + (i.width || '?') + '×' + (i.height || '?');
              list.appendChild(line);
            });
            next.disabled = data.nextOffset === null;
            next.textContent = next.disabled ? 'End of indexed files' : 'Load next 100';
            if (!next.disabled) offset = data.nextOffset;
          }).catch(function () { next.textContent = 'Could not load files'; next.disabled = false; });
      }
      next.addEventListener('click', fetchPage);
      wrap.appendChild(list); wrap.appendChild(next);
    }
    function showScanActivity(id, logSection) {
      var pane = section('Scan activity');
      pane.classList.add('dashboard-scan');
      var current = el('p', { class: 'dashboard-lead' }, 'Loading scan activity…');
      var details = el('p', { class: 'modal-sub' });
      var pauseButton = el('button', { type: 'button', class: 'dashboard-next', hidden: true }, 'Pause indexing');
      var repairButton = el('button', { type: 'button', class: 'dashboard-next' }, 'Media repairs');
      repairButton.onclick = function () { openRepairs(repairButton); };
      var pauseStatus = el('p', { class: 'modal-sub', role: 'status', hidden: true });
      var message = el('p', { class: 'dashboard-scan-status', hidden: true });
      var activeHeading = el('h4', { id: 'dashboard-active-scan-heading' }, 'Active operations');
      var active = el('ul', { class: 'dashboard-scan-list', tabindex: '0', 'aria-labelledby': activeHeading.id, hidden: true });
      var recentHeading = el('h4', { id: 'dashboard-recent-scan-heading' }, 'Recent operations');
      var recent = el('ol', { class: 'dashboard-scan-list', tabindex: '0', 'aria-labelledby': recentHeading.id, hidden: true });
      var recentEmpty = el('p', { class: 'modal-sub' }, 'No recorded operations yet.');
      var logs = el('ol', { class: 'dashboard-scan-list dashboard-log', tabindex: '0', 'aria-label': 'Recent scan log', hidden: true });
      var logsEmpty = el('p', { class: 'modal-sub' }, 'No scan messages yet.');
      var scanActions = el('div', { class: 'dashboard-repair-tools' });
      scanActions.append(repairButton, pauseButton);
      pane.append(current, details, scanActions, pauseStatus, message, activeHeading, active, recentHeading, recent, recentEmpty);
      logSection.append(logs, logsEmpty);
      var signatures = new WeakMap();
      var indexingPaused = false;
      function updatePauseControl(pauseState) {
        indexingPaused = Boolean(pauseState);
        pauseButton.textContent = indexingPaused ? 'Resume indexing' : 'Pause indexing';
      }
      pauseButton.addEventListener('click', async function () {
        pauseButton.disabled = true;
        try {
          var response = await fetch('/api/scan-control', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: !indexingPaused }) });
          var result = await response.json();
          if (!response.ok) throw Error(result.error || 'Could not change indexing state.');
          updatePauseControl(result.pauseState);
          pauseStatus.hidden = false;
          pauseStatus.textContent = indexingPaused ? 'The active operations can finish before indexing pauses.' : 'Indexing resumed.';
          void fetchLibraryStatus();
        } catch (error) {
          pauseStatus.hidden = false;
          pauseStatus.textContent = error.message;
        } finally { pauseButton.disabled = false; }
      });

      function elapsedSince(time, now) {
        var seconds = Math.floor((now - Date.parse(time)) / 1000);
        return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
      }
      function elapsedLabel(seconds) {
        if (seconds < 60) return seconds + 's';
        var minutes = Math.floor(seconds / 60);
        return minutes + 'm ' + seconds % 60 + 's';
      }
      function operationLine(task, now) {
        var fields = [task.stage, task.path || 'media root'];
        var finished = task.finishedAt && Date.parse(task.finishedAt);
        var duration = Math.max(0, (finished || now) - Date.parse(task.startedAt));
        if (finished) fields.push((task.outcome === 'failed' ? 'Failed' : 'Finished') + ' at ' + new Date(finished).toLocaleTimeString());
        if (Number.isFinite(duration)) fields.push(duration < 1000 ? duration + 'ms' : elapsedLabel(Math.floor(duration / 1000)));
        if (Number.isFinite(task.bytesRead) && Number.isFinite(task.size)) {
          fields.push(formatFileSize(task.bytesRead) + ' / ' + formatFileSize(task.size));
        }
        var idleSeconds = elapsedSince(task.lastProgressAt || task.startedAt, now);
        if (!finished && idleSeconds >= 45) fields.push('Awaiting progress for ' + elapsedLabel(idleSeconds));
        var line = el('li', { class: 'dashboard-file' });
        line.textContent = fields.join(' · ');
        return line;
      }
      function updateHistory(list, entries, render) {
        var signature = JSON.stringify(entries);
        if (signatures.get(list) === signature) return;
        signatures.set(list, signature);
        var scrollTop = list.scrollTop;
        var newestFirst = entries.slice().reverse();
        list.replaceChildren(...newestFirst.map(render));
        list.hidden = !entries.length;
        list.scrollTop = scrollTop;
      }
      async function refresh() {
        if (id !== openId) return;
        try {
          if (body.hidden) return;
          var response = await fetch('/api/library-status?details=1');
          if (!response.ok) throw Error('Scan activity unavailable');
          var data = await response.json();
          if (id !== openId) return;
          current.textContent = scanDescription(data);
          if (!data.progress && data.lastScan?.status) current.textContent += ' · Last scan ' + data.lastScan.status;
          var progress = data.progress;
          pauseButton.hidden = !progress;
          if (!progress) pauseStatus.hidden = true;
          if (!pauseButton.disabled) updatePauseControl(progress?.pauseState);
          var now = Date.now();
          var activeTasks = progress?.active || [];
          var recentTasks = progress?.recentActivities || data.recentActivities || [];
          var status = [];
          if (progress?.startedAt) status.push('Started ' + new Date(progress.startedAt).toLocaleTimeString());
          var idleSeconds = elapsedSince(progress?.lastProgressAt, now);
          if (idleSeconds !== null) status.push('Last progress ' + elapsedLabel(idleSeconds) + ' ago');
          if (Number.isFinite(progress?.bytesRead)) status.push(formatFileSize(progress.bytesRead) + ' read for hashing');
          if (data.parallelism) {
            status.push(data.parallelism.workers + ' media-worker ceiling', data.parallelism.effectiveCores + ' effective logical CPUs');
            if (data.parallelism.cacheRamBytes) status.push(formatFileSize(data.parallelism.cacheRamBytes) + ' reserved for RAM cache');
            if (data.parallelism.processingLimit) status.push(data.parallelism.processingLimit + ' background slots');
            if (data.parallelism.workerMultiplier > 1) status.push(data.parallelism.workerMultiplier + '× scan concurrency');
            if (data.parallelism.readers) status.push(data.parallelism.readers + ' source readers');
            if (data.parallelism.metadataWorkers) status.push(data.parallelism.metadataWorkers + ' metadata workers');
            if (data.parallelism.directoryWorkers) status.push(data.parallelism.directoryWorkers + ' directory workers');
          }
          if (data.queued?.length) status.push(data.queued.length + ' queued');
          if (data.pendingStorageReads) status.push(data.pendingStorageReads + ' storage operations still awaiting the OS');
          details.textContent = status.join(' · ');
          message.hidden = !(progress && progress.pauseState !== 'paused' && idleSeconds >= 45);
          message.textContent = message.hidden ? '' : 'The scan has reported no progress for ' + elapsedLabel(idleSeconds) + '. Check the active operations and server log below.';
          activeHeading.textContent = 'Active operations (' + activeTasks.length.toLocaleString() + ')';
          activeHeading.hidden = !data.scanning;
          var scrollTop = active.scrollTop;
          active.replaceChildren(...activeTasks.map(function (task) { return operationLine(task, now); }));
          active.hidden = !activeTasks.length;
          active.scrollTop = scrollTop;
          recentHeading.textContent = 'Recent operations (' + recentTasks.length.toLocaleString() + ')';
          recentEmpty.hidden = Boolean(recentTasks.length);
          updateHistory(recent, recentTasks, function (task) { return operationLine(task, now); });
          var events = data.logs || [];
          logsEmpty.hidden = Boolean(events.length);
          updateHistory(logs, events, function (entry) {
            var line = el('li', { class: 'dashboard-file' });
            line.textContent = new Date(entry.at).toLocaleTimeString() + ' · ' + (entry.level || 'info') + ' · ' + entry.message;
            if (entry.issueId) {
              var review = el('button', { type: 'button', class: 'dashboard-next' }, 'Review repair');
              review.onclick = function () { openRepairs(review, entry.issueId); };
              line.appendChild(review);
            }
            return line;
          });
        } catch (error) {
          if (id === openId) {
            message.hidden = false;
            message.textContent = 'Could not refresh scan activity. Details shown are from the last successful update.';
          }
        } finally {
          if (id === openId) refreshTimer = setTimeout(refresh, 3000);
        }
      }
      void refresh();
      return pane;
    }
    function open(target) {
      returnFocus = document.activeElement || returnFocus;
      clearTimeout(refreshTimer);
      var id = ++openId;
      benchmarkPanel?.dispose();
      folderMapView?.dispose();
      body.replaceChildren();
      scrim.inert = false;
      scrim.setAttribute('aria-hidden', 'false');
      scrim.classList.add('open');
      close.focus({ preventScroll: true });
      var logSection = el('section', { class: 'dashboard-section' });
      logSection.appendChild(el('h3', {}, 'Server logs'));
      logSection.id = 'dashboard-server-logs';
      showScanActivity(id, logSection);
      benchmarkPanel = window.StreamBenchmark.mount(body, {
        version: CONFIG.version,
        videos: function () {
          return Array.from(runningPreviews).map(function (tile) { return tile._video; }).filter(Boolean).slice(0, 8);
        }
      });
      var loading = el('p', { class: 'modal-sub' }, 'Loading library statistics…');
      body.append(loading, logSection);
      if (target === 'notifications') notifications.open();
      if (target === 'repairs') openRepairs();
      fetch('/api/dashboard').then(function (r) { if (!r.ok) throw Error('Dashboard unavailable'); return r.json(); })
        .then(function (d) {
          if (id !== openId) return;
          loading.remove();
          var summary = section('Overview');
          summary.appendChild(el('p', { class: 'dashboard-lead' },
            d.totals.photos.toLocaleString() + ' photos · ' + d.totals.videos.toLocaleString() +
            ' videos · ' + (d.totals.bytes / (1024 ** 3)).toFixed(2) + ' GiB indexed'));
          if (d.lastScan) summary.appendChild(el('p', { class: 'modal-sub' },
            'Last scan: ' + d.lastScan.at + ' · ' + (d.lastScan.durationMs / 1000).toFixed(1) +
            ' seconds · +' + d.lastScan.added + ' new · ' + d.lastScan.updated + ' updated · ' + d.lastScan.removed + ' removed'));
          var folderMap = el('details', { class: 'dashboard-section' });
          folderMap.appendChild(el('summary', {}, 'Folder storage map'));
          body.appendChild(folderMap);
          folderMap.addEventListener('toggle', function () {
            if (id !== openId || !folderMap.open || folderMap.querySelector('.folder-storage-map')) return;
            folderMapView = window.StreamLibraryMap.mountFolders(folderMap, { color: creatorColor });
          });
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
          if (!d.history?.length) scans.appendChild(el('p', {}, 'No scan history yet'));
          window.StreamResources.mount(body, function () { return id === openId; });
          var mapPanel = el('details', { class: 'dashboard-section' });
          mapPanel.appendChild(el('summary', {}, 'Artist map'));
          body.appendChild(mapPanel);
          mapPanel.addEventListener('toggle', function mountMap() {
            if (!mapPanel.open) return;
            mapPanel.removeEventListener('toggle', mountMap);
            window.StreamLibraryMap.mount(mapPanel, {
              color: creatorColor, isOpen: function () { return id === openId; },
              openArtist: function (name) {
                dismiss(); clearGalleryFilters(); state.creator = name; state.sort = 'creator';
                if (header._creatorSelect) header._creatorSelect.value = name;
                resetAndLoad();
              },
              openItem: function (itemId) {
                dismiss(); clearGalleryFilters(); resetAndLoad();
                fetch('/api/item/' + encodeURIComponent(itemId)).then(function (r) { return r.json(); })
                  .then(function (data) { if (data.item) openLightbox(data.item, true); });
              }
            });
          });
          showFiles();
          showAiControls();
          body.appendChild(logSection);
          if (target === 'issues') notifications.open();
        }).catch(function () { if (id === openId) loading.textContent = 'Could not load library statistics.'; });
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
      btn.addEventListener('click', signOut);
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

  var artistOutlines=window.StreamArtistOutlines.install(grid,{mode:storageGet('stream-artist-outlines','off'),color:creatorColor});
  artistOutlines.setMode(storageGet('stream-artist-outlines','off'));
  grid.style.setProperty('--gap',storageGet('stream-artist-outlines','off')==='off'?'0px':'1px');
  function updateArtistSpacing(mode) { grid.style.setProperty('--gap', mode === 'off' ? '0px' : '1px'); remeasureAndReflow(); }
  var sentinel = el('li', { class: 'sentinel' });
  var statusEl = el('div', { class: 'grid-status', role: 'status', 'aria-live': 'polite' });
  var toGalleryStart = el('button', { class: 'load-retry', type: 'button', hidden: '' }, 'Start of folder');
  toGalleryStart.onclick = function () {
    window.scrollTo({ top: 0, behavior: 'instant' });
    resetAndLoad();
  };
  main.insertBefore(toGalleryStart, grid);
  statusEl.style.display = 'none';
  main.appendChild(statusEl);

  var columnWidth = 0;
  var gridGap = 0, rowUnit = 1;
  function measureColumns() {
    var computed = getComputedStyle(grid);
    var cols = computed.gridTemplateColumns.split(' ').filter(Boolean);
    columnWidth = cols.length ? parseFloat(cols[0]) : grid.clientWidth;
    gridGap = parseFloat(computed.gap) || 0;
    rowUnit = parseFloat(computed.gridAutoRows) || 1;
  }

  function applySpan(tile, item) {
    if (!columnWidth) measureColumns();
    var aspect = item.width && item.height ? item.width / item.height : 1;
    var gap = gridGap;
    var width = tile.classList.contains('tile-expanded') && window.innerWidth > 580 ? columnWidth * 2 + gap : columnWidth;
    var tileHeight = width / aspect;
    var span = Math.max(1, Math.ceil((tileHeight + gap) / (rowUnit + gap)));
    tile.style.gridRowEnd = 'span ' + span;
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
    if (state.folder) params.set('folder', state.folder);
    if (window.StreamFolders?.configured()) params.set('metadata', '0');
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
    if (state.sort === 'random' || state.sort === 'less-seen') params.set('seed', state.seed);
    params.set('total', '0');
    if (cursor) params.set('cursor', cursor);
    if (pagesLoaded) params.set('metadata', '0');
    return '/api/items?' + params.toString();
  }

  var galleryPlaceKey = 'stream-gallery-place-' + (CONFIG.node?.id || 'local');
  var placeFields = ['type', 'album', 'creator', 'dateField', 'dateFrom', 'dateTo', 'resolution', 'has', 'q', 'sort', 'seed'];
  var initialView = galleryView();
  var recentPlaces = [];
  var pagesLoaded = 0, priorPageCursor = null, restoreTask = null, scrollCheckpointTimer;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try {
    var stored = JSON.parse(sessionStorage.getItem(galleryPlaceKey) || '[]');
    if (Array.isArray(stored)) recentPlaces = stored.slice(0, 24);
  } catch (_) {}

  function galleryView() {
    return Object.fromEntries(placeFields.map(function (key) { return [key, state[key]]; }));
  }

  function applyGalleryPlace(place) {
    var view = place?.view;
    placeFields.forEach(function (key) { state[key] = view?.[key] ?? initialView[key]; });
    header._albumSelect.value = state.album || '';
    header._creatorSelect.value = state.creator || '';
    var inputs = [
      ['Filter by type', state.type || ''], ['Date filter field', state.dateField],
      ['From date', state.dateFrom || ''], ['To date', state.dateTo || ''],
      ['Minimum resolution', String(state.resolution)], ['Sort order', state.sort]
    ];
    inputs.forEach(function (entry) {
      var input = header.querySelector('[aria-label="' + entry[0] + '"]');
      if (input) input.value = entry[1];
    });
    var search = header.querySelector('input[type=search]');
    if (search) {
      search.value = state.q;
      search.closest('.search-wrap').classList.toggle('open', Boolean(state.q));
    }
    refreshContainsHighlight();
  }

  function tileNearViewportTop() {
    var width = Math.max(1, document.documentElement.clientWidth);
    var start = Math.max(0, header.getBoundingClientRect().bottom) + 2;
    for (var y of [start, start + 24, start + 72, start + 128]) {
      if (y >= window.innerHeight) break;
      for (var fraction of [0.5, 0.25, 0.75, 0.1, 0.9]) {
        var tile = document.elementFromPoint(Math.floor(width * fraction), y)?.closest('.tile');
        if (tile && grid.contains(tile)) return tile;
      }
    }
    return null;
  }

  function rememberGalleryPlace() {
    if (lb.open || restoreTask || !state.loadedOnce || (state.loading && !pagesLoaded)) return;
    var tile = window.scrollY > 8 ? tileNearViewportTop() : null;
    var folder = state.folder || '';
    var place = {
      folder: folder, view: galleryView(), itemId: tile?.dataset.itemId || null,
      cursor: tile?._restoreCursor || null,
      offset: tile ? Math.round(tile.getBoundingClientRect().top) : 0
    };
    if (window.scrollY > 8 && !tile) return;
    recentPlaces = [place].concat(recentPlaces.filter(function (entry) { return entry?.folder !== folder; })).slice(0, 24);
    try { sessionStorage.setItem(galleryPlaceKey, JSON.stringify(recentPlaces)); } catch (_) {}
    return place;
  }

  function clearGalleryPlaces() {
    recentPlaces = [];
    clearTimeout(scrollCheckpointTimer);
    try { sessionStorage.removeItem(galleryPlaceKey); } catch (_) {}
  }

  function currentFolderPlace(entry) {
    var folder = state.folder || '';
    return (entry?.folder === folder ? entry : null) || recentPlaces.find(function (place) { return place?.folder === folder; });
  }

  function galleryAddress(id) {
    var url = new URL(location.href);
    url.pathname = id ? '/' + encodeURIComponent(id) : '/';
    if (window.StreamFolders?.configured()) url.searchParams.set('folder', state.folder || '');
    else url.searchParams.delete('folder');
    return url.pathname + url.search + url.hash;
  }

  function rememberCurrentEntry() {
    var place = rememberGalleryPlace() || currentFolderPlace();
    history.replaceState(Object.assign({}, history.state, { streamGallery: place }), '', location.href);
    return place;
  }

  async function restoreGallery(place) {
    if (!place?.itemId) return loadMore();
    var task = restoreTask = { token: state.loadToken };
    state.cursor = place.cursor || null;
    toGalleryStart.hidden = !state.cursor;
    var limit = state.cursor ? 3 : 10;
    var anchor = null;
    try {
      for (var page = 0; page < limit && !state.done; page++) {
        var loaded = await loadMore();
        if (restoreTask !== task || state.loadToken !== task.token || !loaded) return;
        anchor = anchor || grid.querySelector('[data-item-id="' + CSS.escape(place.itemId) + '"]');
        if (anchor) {
          window.scrollBy({ top: anchor.getBoundingClientRect().top - place.offset, behavior: 'instant' });
          if (state.done || Math.abs(anchor.getBoundingClientRect().top - place.offset) < 2) return;
        }
      }
      if (!anchor && place.cursor && restoreTask === task) resetAndLoad();
    } finally {
      if (restoreTask === task) {
        restoreTask = null;
        if (!state.done && sentinel.isConnected) scrollObserver.observe(sentinel);
        refillPreviews();
      }
    }
  }

  window.addEventListener('scroll', function () {
    if (restoreTask || lb.open) return;
    clearTimeout(scrollCheckpointTimer);
    scrollCheckpointTimer = setTimeout(rememberGalleryPlace, 200);
  }, { passive: true });
  window.addEventListener('pagehide', rememberGalleryPlace);

  function loadMore() {
    if (state.loading || state.done) return Promise.resolve();
    state.loading = true;
    var myToken = state.loadToken;
    var requestedCursor = state.cursor;
    statusEl.style.display = 'block';
    grid.setAttribute('aria-busy', 'true');
    if (entrance) entrance.loading(statusEl);
    else statusEl.textContent = 'Loading…';
    var requestStarted = performance.now(), responseRecorded = false;
    return fetch(apiUrl(requestedCursor))
      .then(function (r) { return r.json().then(function (data) {
        window.StreamDiagnostics?.catalogResponse(requestStarted, r.status); responseRecorded = true;
        if (!r.ok) throw Error('Could not load gallery');
        return data;
      }); })
      .then(function (data) {
        if (myToken !== state.loadToken) return;
        state.loadedOnce = true;
        if (!pagesLoaded) {
          updateAlbumOptions(data.albums);
          updateCreatorOptions(data.creators);
        }
        updateObjectClassOptions(data.objectClasses);
        if (data.items.length === 0 && !state.cursor) {
          showEmptyState();
        } else {
          hideEmptyState();
          var batch = document.createDocumentFragment();
          measureColumns();
          var cursor = toGalleryStart.hidden && pagesLoaded < 8 ? null : priorPageCursor || requestedCursor;
          data.items.forEach(function (item) { addTile(item, batch, cursor); });
          grid.appendChild(batch);
          entrance?.gallery(grid, Boolean(INITIAL_ITEM));
        }
        pagesLoaded++;
        priorPageCursor = requestedCursor;
        state.cursor = data.nextCursor;
        state.done = !data.nextCursor;
        statusEl.style.display = 'none';
        entrance?.loaded(statusEl);
        grid.setAttribute('aria-busy', 'false');
        state.loading = false;
        scrollObserver.unobserve(sentinel);
        grid.appendChild(sentinel);
        if (!state.done && !restoreTask) scrollObserver.observe(sentinel);
        if (!INITIAL_ITEM) entrance?.welcome(appEl);
        return true;
      })
      .catch(function () {
        if (!responseRecorded) window.StreamDiagnostics?.catalogResponse(requestStarted, 0);
        if (myToken !== state.loadToken) return;
        entrance?.loaded(statusEl);
        statusEl.textContent = 'Could not load your library. ';
        var retry = el('button', { type: 'button', class: 'load-retry' }, 'Try again');
        retry.onclick = loadMore;
        statusEl.appendChild(retry);
        grid.setAttribute('aria-busy', 'false');
        state.loading = false;
      });
  }

  function resetAndLoad() {
    return rebuildGallery();
  }

  function rebuildGallery(place) {
    if (galleryRefreshSuggested) { galleryRefreshSuggested = false; renderLibrarySummary(); }
    state.loadToken = (state.loadToken || 0) + 1;
    state.loading = false;
    pagesLoaded = 0;
    priorPageCursor = null;
    restoreTask = null;
    toGalleryStart.hidden = true;
    grid.classList.add('refreshing');
    scrollObserver.unobserve(sentinel);
    tileViewportObserver.disconnect(); lazyObserver.disconnect(); autoplayObserver.disconnect(); previewController.clear();
    if (bg) bg.clearTiles();
    grid.replaceChildren();
    state.cursor = null;
    state.done = false;
    return restoreGallery(place).finally(function () { grid.classList.remove('refreshing'); });
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
    sel.style.display = creators.length && !window.StreamFolders?.configured() ? '' : 'none';
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
    sel.style.display = albums.length && !window.StreamFolders?.configured() ? '' : 'none';
  }

  window.addEventListener('stream:folder-change', function (event) {
    var nextFolder = event.detail.id || null;
    if (!event.detail.initial && !event.detail.history && !event.detail.settingsChanged) rememberCurrentEntry();
    if (event.detail.history) rememberGalleryPlace();
    var changedFolder = state.folder !== nextFolder;
    state.folder = nextFolder;
    lastCreators = lastAlbums = null;
    if (event.detail.configured) {
      header._albumSelect.style.display = 'none';
      header._creatorSelect.style.display = 'none';
    }
    if (!event.detail.initial) {
      if (event.detail.settingsChanged) {
        if (changedFolder) history.replaceState(Object.assign({}, history.state, { streamGallery: null }), '', galleryAddress(lb.open ? lb.item.id : null));
        resetAndLoad();
        return;
      }
      if (!event.detail.history) {
        var entry = { streamGallery: currentFolderPlace() };
        if (changedFolder) history.pushState(entry, '', galleryAddress(null));
        else {
          history.replaceState(entry, '', galleryAddress(null));
          return;
        }
      }
      var place = currentFolderPlace(history.state?.streamGallery);
      applyGalleryPlace(place);
      window.scrollTo({ top: 0, behavior: 'instant' });
      rebuildGallery(place);
    }
  });

  function refreshContainsHighlight() {
    if (!header._containsSection) return;
    Array.prototype.forEach.call(header._containsSection.querySelectorAll('.menu-item'), function (b) {
      var selected = b.dataset.has === (state.has || '');
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
  }

  var objectClassesPopulated = false;
  function updateObjectClassOptions(classes) {
    if (objectClassesPopulated || !classes || classes.length === 0 || !header._containsSection) return;
    objectClassesPopulated = true;
    var section = header._containsSection;
    section.appendChild(el('div', { class: 'menu-divider' }));
    classes.forEach(function (cls) {
      var item = el('button', { type: 'button', class: 'menu-item', 'data-has': cls, 'aria-pressed': 'false' }, '<span>' + cls + '</span>');
      item.addEventListener('click', function () {
        state.has = cls;
        refreshContainsHighlight();
        resetAndLoad();
      });
      section.appendChild(item);
    });
  }

  function showEmptyState() {
    var empty = el('div', { class: 'empty', id: 'empty-state' },
      '<div class="empty-mark"></div><h2>Nothing here yet</h2>');
    var detail = el('p', { role: 'status' }, 'Scan your media folder to import local files.');
    empty.appendChild(detail);
    var scan = el('button', { type: 'button', class: 'dashboard-next empty-scan-btn' }, 'Scan library now');
    scan.onclick = async function () {
      if (await queueLibraryScan(scan, false, state.folder)) {
        detail.textContent = 'Scan requested. Open Dashboard to follow its progress.';
        scan.disabled = true;
      }
    };
    empty.appendChild(scan);
    main.appendChild(empty);
  }
  function hideEmptyState() {
    var existing = document.getElementById('empty-state');
    if (existing) existing.remove();
  }


  var tileViewportObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var tile = entry.target;
      tile._nearViewport = entry.isIntersecting;
      if (entry.isIntersecting) hydrateTile(tile);
      else dehydrateTile(tile);
    });
  }, { rootMargin: '1000px' });

  var warmImages = new Map();
  var warmImageBytes = 0;

  function takeWarmImage(url) {
    var entry = warmImages.get(url);
    if (!entry) return null;
    warmImages.delete(url);
    warmImageBytes -= entry.bytes;
    return entry.image;
  }

  function rememberImage(image) {
    if (dataSaverMode || !image.complete || !image.naturalWidth || !image.currentSrc) return false;
    if (image.dataset.animated === 'true') return false;
    var sourceWidth = Number(new URL(image.currentSrc).searchParams.get('w')) || image.naturalWidth;
    var bytes = Math.max(sourceWidth, image.naturalWidth) ** 2 * image.naturalHeight / image.naturalWidth * 4;
    var budget = 24 * 1024 * 1024;
    if (bytes > budget) return false;
    takeWarmImage(image.dataset.src);
    warmImages.set(image.dataset.src, { image: image, bytes: bytes });
    warmImageBytes += bytes;
    while (warmImages.size > 96 || warmImageBytes > budget) takeWarmImage(warmImages.keys().next().value);
    return true;
  }

  function dehydrateTile(tile, force) {
    if (!tile._hydrated || (!force && (tile._nearViewport || tile.contains(document.activeElement) || tile.matches(':hover')))) return;
    bg?.unwatchTile(tile);
    if (tile._item.type === 'video') {
      autoplayObserver.unobserve(tile);
      previewController.setVisible(tile, false);
    }
    var image = tile.querySelector('img.tile-media');
    if (image) {
      lazyObserver.unobserve(image);
      if (!rememberImage(image)) {
        image.removeAttribute('srcset');
        image.removeAttribute('src');
      }
    }
    tile.replaceChildren();
    tile._hydrated = false;
    delete tile.dataset.hydrated;
  }

  var lazyObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var img = entry.target;
      if (img.dataset.srcset) img.srcset = img.dataset.srcset;
      img.src = img.dataset.src;
      lazyObserver.unobserve(img);
    });
  }, { rootMargin: dataSaverMode ? '100px' : '500px' });

  var backgroundBusy;
  function updateBackgroundBusy() {
    var activeVideo=lb && lb.open ? lightbox.mediaWrap.querySelector('video') : null;
    var busy=Boolean((previewController && previewController.running.size) || (activeVideo && !activeVideo.paused));
    if (busy === backgroundBusy) return;
    backgroundBusy = busy;
    document.documentElement.toggleAttribute('data-render-busy',busy);
    if (bg) bg.setBusy(busy);
  }

  function currentPreviewSource() {
    return lightweightGallery ? 'preview' : previewSource;
  }

  function previewUrl(item) {
    return currentPreviewSource() === 'original' ? item.urls.original : item.urls.preview;
  }

  var previewMemory = window.StreamPreviewMemory.create({ budget: previewMemoryMiB * 1024 ** 2 });
  var previewController = window.StreamPreviewController.create({enabled:function () { return autoplayEnabled && !dataSaverMode; },
    blocked:function () { return Boolean(restoreTask) || document.hidden || document.body.classList.contains('lb-open'); },limit:function () { return MAX_PREVIEWS; },
    attach:attachVideoPreview,source:previewUrl,onChange:updateBackgroundBusy});
  var runningPreviews = previewController.running;
  var inViewVideoTiles = previewController.inView;
  function updatePreviewVisibility(entries) {
    entries.forEach(function (entry) {
      var tile = entry.target;
      if (!tile._hydrated) return;
      previewController.setVisible(tile, entry.isIntersecting);
    });
  }
  var autoplayObserver = new IntersectionObserver(updatePreviewVisibility, { rootMargin: '80px' });

  var scrollObserver = new IntersectionObserver(function (entries) {
    if (entries.at(-1).isIntersecting) loadMore();
  }, { rootMargin: '900px' });

  function attachVideoPreview(tile, item, source) {
    if (tile._video) {
      if (tile._video.parentNode !== tile) tile.appendChild(tile._video);
      return tile._video;
    }
    var video = document.createElement('video');
    var timeline = source === item.urls.preview && Number.isFinite(item.duration) && item.duration > 60;
    var clipCount = timeline ? Math.ceil(item.duration / 60) : 1;
    var clip = timeline && tile._previewMinute < clipCount ? tile._previewMinute || 0 : 0;
    var nextAfterFallback = 0, failedMinute = 0, failures = 0;
    video.className = 'tile-media tile-video-el';
    video.muted = true;
    video.loop = !timeline;
    video.playsInline = true;
    video.preload = 'metadata';
    video._streamItem = item;
    tile._video = video;
    var sourceChange = 0;
    function playIfActive() {
      if (!document.hidden && runningPreviews.has(tile)) video.play().catch(function () {});
    }
    function setClip(minute, autoplay) {
      var generation = ++sourceChange;
      clip = minute;
      tile._previewMinute = minute;
      if (autoplay) tile._resumeAt = 0;
      var url = minute === 0 ? source : source + (source.includes('?') ? '&' : '?') + 'minute=' + minute;
      video._previewMemoryLease?.release();
      video._previewMemoryLease = null;
      video._previewMemoryKey = null;
      video._previewClipUrl = source === item.urls.preview ? url : null;
      video._previewDownload = null;
      function select(lease) {
        if (tile._video !== video || generation !== sourceChange) { lease?.release(); return; }
        video._previewMemoryLease = lease;
        video._previewMemoryKey = lease ? url : null;
        video.src = lease?.url || url;
        if (autoplay) playIfActive();
      }
      if (previewMemoryMiB > 0 && source === item.urls.preview)
        video._previewDownload = previewMemory.acquire(url).then(select);
      else select(null);
    }
    setClip(clip, false);
    if (timeline) {
      function advanceClip() {
        if (tile._video !== video || document.hidden || !runningPreviews.has(tile)) return;
        var next = nextAfterFallback || ((clip + 1) % clipCount);
        nextAfterFallback = 0;
        setClip(next, true);
      }
      video.addEventListener('ended', advanceClip);
      video.addEventListener('timeupdate', function () {
        if (clip === 0 && video.duration > 5.5 && video.currentTime >= 5) advanceClip();
      });
    }
    video.addEventListener('error', function () {
      if (tile._video !== video) return;
      video.classList.remove('has-frame');
      if (video._previewMemoryLease) {
        previewMemory.discard(video._previewClipUrl);
        video._previewMemoryLease.release();
        video._previewMemoryLease = null;
        video._previewMemoryKey = null;
        video.src = video._previewClipUrl;
        playIfActive();
        return;
      }
      if (timeline && clip > 0) {
        failures = failedMinute === clip ? failures + 1 : 1;
        failedMinute = clip;
        nextAfterFallback = failures < 2 ? clip : (clip + 1) % clipCount;
        setClip(0, true);
        previewController.schedule();
        return;
      }
      if (currentPreviewSource() === 'original' && item.urls.preview && video.getAttribute('src') === item.urls.original) {
        video.src = item.urls.preview;
        if (!document.hidden && runningPreviews.has(tile)) video.play().catch(function () {});
        showToast('Original format unsupported here; using preview');
      }
    });
    tile.appendChild(video);
    video.addEventListener('playing', function () {
      video.classList.add('has-frame', 'playing');
      var label = tile.querySelector('.tile-live-label');
      if (label) label.textContent = timeline ? formatDuration(clip * 60) : 'LIVE';
      tile.querySelector('.tile-live')?.classList.add('on');
    });
    video.addEventListener('pause', function () {
      video.classList.remove('playing');
      tile.querySelector('.tile-live')?.classList.remove('on');
    });
    return video;
  }

  function playPreview(tile) {
    previewController.play(tile);
  }
  function pausePreview(tile) {
    previewController.pause(tile);
  }
  function refillPreviews() {
    previewController.schedule();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) previewController.suspend();
    else {
      updatePreviewVisibility(autoplayObserver.takeRecords());
      previewController.refill();
    }
  });

  function clearPreviewMemory() {
    previewController.clear();
    previewMemory.clear();
  }
  async function signOut() {
    var response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw Error('Could not sign out.');
    try { localStorage.setItem('stream-signed-out', String(Date.now())); } catch (_) {}
    clearPreviewMemory();
    clearGalleryPlaces();
    location.replace('/');
  }
  window.StreamSignOut = signOut;
  window.addEventListener('storage', function (event) {
    if (event.key !== 'stream-signed-out') return;
    clearPreviewMemory();
    clearGalleryPlaces();
    location.replace('/');
  });

  var revalidatePreviewTab = false;
  window.addEventListener('pagehide', function () {
    revalidatePreviewTab = previewMemoryMiB > 0 || previewMemory.stats().bytes > 0;
    if (revalidatePreviewTab) clearPreviewMemory();
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted && revalidatePreviewTab) location.reload();
  });

  function creatorColor(name) {return window.StreamLayout.color(name,storageGet('stream-artist-palette','default'));}

  function addTile(item, parent, restoreCursor) {
    var creator = item.creator || '(Unsorted)';
    var tile = el('li', { class: 'tile', tabindex: '0', role: 'button', 'aria-label': 'Open ' + item.filename, 'data-item-id': item.id });
    tile.style.background = item.color;
    tile._item = item;
    tile._restoreCursor = restoreCursor;
    var hoverTimer;
    tile.addEventListener('pointerenter', function () {
      hydrateTile(tile);
      hoverTimer = setTimeout(function () { if (tile.isConnected) window.StreamActivity.record(item, 'hover'); }, 500);
      if (item.type === 'video' && canHover) playPreview(tile);
      if (bg) bg.setHoverColor(item.color);
    });
    tile.addEventListener('pointerleave', function () {
      clearTimeout(hoverTimer);
      if (item.type === 'video' && !inViewVideoTiles.has(tile)) pausePreview(tile);
      dehydrateTile(tile);
    });
    tile.addEventListener('focusin', function () { hydrateTile(tile); });
    tile.addEventListener('focusout', function () { queueMicrotask(function () { dehydrateTile(tile); }); });
    tile.style.setProperty('--source-color', creatorColor(creator));
    if (item.type === 'video') {
      tile.classList.add('video-tile');
      if (randomEnabled ? randomLarge(item.id) : videoScale === '2') tile.classList.add('tile-expanded');
    }

    tile.addEventListener('click', function () {
      openLightbox(item, true);
    });
    tile.addEventListener('keydown', function (e) {
      if (e.target !== tile) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openLightbox(item, true);
    });

    (parent || grid).appendChild(tile);
    applySpan(tile, item);
    tileViewportObserver.observe(tile);
  }

  function hydrateTile(tile) {
    if (tile._hydrated || !tile.isConnected) return;
    tile._hydrated = true;
    tile.dataset.hydrated = 'true';
    var item = tile._item;
    bg?.watchTile(tile, item.color);
    var creator = item.creator || '(Unsorted)';
    var sourceLabel = el('span', { class: 'tile-source', title: item.album || creator });
    var originName = el('strong'); originName.textContent = item.displayCreator || creator;
    sourceLabel.appendChild(originName);
    var originSub = el('small'); originSub.textContent = item.album || 'Top-level folder';
    sourceLabel.appendChild(originSub);
    tile.appendChild(sourceLabel);

    var smallest = lightweightGallery ? item.urls.thumbSrcset?.match(/^(\S+) \d+w(?:,|$)/)?.[1] : null;
    var thumbnail = smallest || item.urls.thumb;
    var retained = takeWarmImage(thumbnail);
    var img = retained || el('img', { class: 'tile-media', alt: '' });
    if (!retained) {
      img.dataset.src = thumbnail;
      if (item.isAnimated) img.dataset.animated = 'true';
      if (!lightweightGallery && item.urls.thumbSrcset) img.dataset.srcset = item.urls.thumbSrcset;
      img.addEventListener('load', function () { img.classList.add('loaded'); window.StreamDiagnostics?.thumbnailLoaded(img); });
    }
    tile.appendChild(img);
    if (!retained) lazyObserver.observe(img);

    if (item.type === 'video') {
      var expand = el('button', { type: 'button', class: 'tile-expand', title: 'Toggle large video tile', 'aria-label': 'Resize this video tile' }, icon('expand'));
      expand.addEventListener('click', function (e) {
        e.stopPropagation();
        tile.classList.toggle('tile-expanded');
        tile.dataset.manualScale = '1';
        remeasureAndReflow();
      });
      tile.appendChild(expand);
      var live = el('span', { class: 'tile-live' }, '<span class="tile-live-dot"></span><span class="tile-live-label">LIVE</span>');
      tile.appendChild(live);
      if (item.duration) {
        tile.appendChild(el('span', { class: 'tile-duration mono' }, formatDuration(item.duration)));
      }
      if (!dataSaverMode) autoplayObserver.observe(tile);
    }

    applySpan(tile, item);
  }


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
    var root = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer', 'aria-hidden': 'true', tabindex: '-1' });
    root.inert = true;
    var focusStart = el('span', { class: 'viewer-focus-guard', tabindex: '0' });
    var focusEnd = el('span', { class: 'viewer-focus-guard', tabindex: '0' });
    var card = el('div', { class: 'lightbox-card' });
    var bar = el('div', { class: 'lightbox-bar' });
    var counter = el('div', { class: 'frame-counter mono' }, '');
    var actions = el('div', { class: 'lightbox-actions' });
    var slideshowBtn = el('button', { class: 'icon-btn', title: 'Play slideshow', 'aria-label': 'Play slideshow' }, icon('play'));
    var editBtn = el('button', { class: 'icon-btn', title: 'Quick edit', 'aria-label': 'Quick edit' }, icon('edit'));
    var infoBtn = el('button', { class: 'icon-btn', title: 'Info', 'aria-label': 'Photo/video info' }, icon('info'));
    var statsBtn = el('button', { class: 'icon-btn', title: 'Stats for nerds', 'aria-label': 'Toggle video playback statistics', style: 'display:none' }, icon('chart'));
    var viewerSettingsBtn = el('button', { class: 'icon-btn', title: 'Viewer settings', 'aria-label': 'Viewer settings' }, icon('settings'));
    var speed = el('select', { class: 'player-speed', 'aria-label': 'Playback speed', title: 'Playback speed', style: 'display:none' });
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].forEach(function (rate) { speed.add(new Option(rate + '×', String(rate))); });
    speed.value = '1';
    var downloadLink = el('a', { class: 'icon-btn', title: 'Download original', 'aria-label': 'Download original' }, icon('download'));
    var closeBtn = el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close' }, icon('close'));
    var preferenceButtons = {};
    [['favorite','star','Best'],['pinned','pin','Pin'],['bookmarked','bookmark','Bookmark']].forEach(function (entry) {
      var button = el('button', { class:'icon-btn', title:entry[2], 'aria-label':entry[2], style:isAdmin ? '' : 'display:none' }, icon(entry[1]));
      button.addEventListener('click', function () { setPreference(lb.item, entry[0]); });
      preferenceButtons[entry[0]] = button; actions.appendChild(button);
    });
    actions.appendChild(slideshowBtn);
    actions.appendChild(editBtn);
    actions.appendChild(infoBtn);
    actions.appendChild(statsBtn);
    actions.appendChild(speed);
    actions.appendChild(viewerSettingsBtn);
    actions.appendChild(downloadLink);
    bar.appendChild(counter);
    bar.appendChild(actions);
    bar.appendChild(closeBtn);

    var stage = el('div', { class: 'lightbox-stage' });
    var prevBtn = el('button', { class: 'lightbox-nav prev', 'aria-label': 'Previous', title: 'Previous item' }, icon('chevronLeft'));
    var nextBtn = el('button', { class: 'lightbox-nav next', 'aria-label': 'Next', title: 'Next item' }, icon('chevronRight'));
    var mediaWrap = el('div', { class: 'lightbox-media-wrap' });
    stage.appendChild(prevBtn);
    stage.appendChild(mediaWrap);
    stage.appendChild(nextBtn);

    var captionBar = el('div', { class: 'lightbox-caption-bar' });
    var caption = el('div', { class: 'lightbox-caption mono' });
    var seeks = el('div', { class: 'player-seek', 'aria-label': 'Seek video', role: 'group', hidden: '' });
    var backTen = el('button', { type: 'button', 'aria-label': 'Back 10 seconds', title: 'Back 10 seconds (←)' }, '−10s');
    var forwardTen = el('button', { type: 'button', 'aria-label': 'Forward 10 seconds', title: 'Forward 10 seconds (→)' }, '+10s');
    backTen.addEventListener('click', function () { seekVideo(-10); });
    forwardTen.addEventListener('click', function () { seekVideo(10); });
    seeks.append(backTen, forwardTen);
    captionBar.append(caption, seeks);

    var editPanel = el('div', { class: 'edit-panel' });
    editPanel.inert = true;
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

    var infoPanel = el('div', { class: 'info-panel' });
    infoPanel.inert = true;
    var infoHeader = el('div', { class: 'info-panel-header' });
    infoHeader.appendChild(el('span', {}, 'Info'));
    var infoCloseBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close info' }, icon('close'));
    infoHeader.appendChild(infoCloseBtn);
    var infoList = el('dl', { class: 'info-list' });
    infoPanel.appendChild(infoHeader);
    infoPanel.appendChild(infoList);

    card.appendChild(bar);
    card.appendChild(stage);
    card.appendChild(captionBar);
    root.appendChild(focusStart);
    root.appendChild(card);
    root.appendChild(focusEnd);
    card.appendChild(editPanel);
    card.appendChild(infoPanel);
    function viewerControls() {
      return Array.from(card.querySelectorAll('button:not(:disabled),a[href],select,input,video[controls],[tabindex="0"]')).filter(function (node) {
        return node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]');
      });
    }
    focusStart.addEventListener('focus', function () { var controls = viewerControls(); (controls[controls.length - 1] || closeBtn).focus(); });
    focusEnd.addEventListener('focus', function () { var controls = viewerControls(); (controls[0] || closeBtn).focus(); });

    closeBtn.addEventListener('click', function () { stopSlideshow(); closeLightbox(); });
    root.addEventListener('click', function (e) { if (e.target === root) { stopSlideshow(); closeLightbox(); } });
    prevBtn.addEventListener('click', function () { stopSlideshow(); navigate(-1); });
    nextBtn.addEventListener('click', function () { stopSlideshow(); navigate(1); });
    slideshowBtn.addEventListener('click', toggleSlideshow);
    statsBtn.addEventListener('click', function () { setVideoStatsEnabled(!videoStatsEnabled); });
    viewerSettingsBtn.addEventListener('click', window.StreamSettings.open);
    speed.addEventListener('change', function () { var video = mediaWrap.querySelector('video'); if (video) { video.defaultPlaybackRate = Number(speed.value); video.playbackRate = Number(speed.value); } });

    editBtn.addEventListener('click', function () {
      editPanel.classList.toggle('open');
      editPanel.inert = !editPanel.classList.contains('open');
      editBtn.classList.toggle('active', editPanel.classList.contains('open'));
      infoPanel.classList.remove('open');
      infoPanel.inert = true;
      infoBtn.classList.remove('active');
    });
    infoBtn.addEventListener('click', function () {
      infoPanel.classList.toggle('open');
      infoPanel.inert = !infoPanel.classList.contains('open');
      infoBtn.classList.toggle('active', infoPanel.classList.contains('open'));
      editPanel.classList.remove('open');
      editPanel.inert = true;
      editBtn.classList.remove('active');
    });
    infoCloseBtn.addEventListener('click', function () {
      infoPanel.classList.remove('open');
      infoPanel.inert = true;
      infoBtn.focus();
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
      root: root, card: card, speed: speed, closeBtn: closeBtn, counter: counter, mediaWrap: mediaWrap, prevBtn: prevBtn, nextBtn: nextBtn,
      caption: caption, seeks: seeks, downloadLink: downloadLink, slideshowBtn: slideshowBtn,
      editBtn: editBtn, infoBtn: infoBtn, statsBtn: statsBtn, editPanel: editPanel, infoPanel: infoPanel, infoList: infoList,
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
    returnFocus: null,
  };

  var slideshow = { active: false, timer: null };
  function startSlideshow() {
    if (!lb.next) return;
    slideshow.active = true;
    lightbox.slideshowBtn.innerHTML = icon('pause');
    lightbox.slideshowBtn.classList.add('is-playing-slideshow');
    lightbox.slideshowBtn.title = 'Pause slideshow';
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

  var editState = { rotation: 0, brightness: 100, volume: 100 };

  function resetEditState() {
    editState.rotation = 0;
    editState.brightness = 100;
    editState.volume = 100;
    lightbox.brightnessSlider.value = '100';
    lightbox.volumeSlider.value = '100';
    lightbox.editPanel.classList.remove('open');
    lightbox.editPanel.inert = true;
    lightbox.infoPanel.classList.remove('open');
    lightbox.infoPanel.inert = true;
    lightbox.infoBtn.classList.remove('active');
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
    if(isAdmin){rows += infoRow('Permanent media ID',item.mediaId);rows += infoRow('Link ID',item.id);}
    rows += infoRow('Artist label',item.displayCreator||item.creator);
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
  var stopFirstFrameMeasurement = null;
  function releaseLightboxMedia() {
    if (stopActivity) { stopActivity(); stopActivity = null; }
    if (stopStatsSampling) { stopStatsSampling(); stopStatsSampling = null; }
    if (stopFirstFrameMeasurement) { stopFirstFrameMeasurement(); stopFirstFrameMeasurement = null; }
    if (bg) bg.detachAudio();
    var video = lightbox.mediaWrap.querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    lightbox.mediaWrap.replaceChildren();
  }
  function renderLightboxMedia(item) {
    releaseLightboxMedia();
    resetEditState();
    lightbox.mediaWrap.style.background = item.color;
    var media;
    if (item.type === 'photo') {
      media = el('img', { src: item.urls.full, alt: item.filename });
      if (item.urls.fullSrcset) media.srcset = item.urls.fullSrcset;
    } else {
      media = document.createElement('video');
      stopFirstFrameMeasurement = window.StreamDiagnostics?.trackPlayer(media);
      media.src = item.urls.full;
      media.controls = true;
      media.playsInline = true;
      media.autoplay = true;
      media.dataset.sourceKind = 'original';
      media._streamItem = item;
      media.addEventListener('play', updateBackgroundBusy);media.addEventListener('pause',updateBackgroundBusy);
      media.addEventListener('error', function () { if (media.isConnected) window.StreamLibraryTools?.preparePlayback(media,item); });
      media.defaultPlaybackRate = Number(lightbox.speed.value);
      media.playbackRate = Number(lightbox.speed.value);
      media.poster = item.urls.thumb;
      media.addEventListener('loadedmetadata', function () {
        if (slideshow.active) return;
        var position = window.StreamActivity.position?.(item) ?? item.resumePosition;
        var duration = media.duration;
        if (!Number.isFinite(position) || position <= 0 || !Number.isFinite(duration) ||
            position >= duration - Math.min(2, duration * .05)) return;
        media.currentTime = position;
      });
      if (slideshow.active) bindSlideshowEnded(media);
    }
    lightbox.mediaWrap.appendChild(media);
    lightbox.root.classList.toggle('showing-video', item.type === 'video');
    lightbox.seeks.hidden = item.type !== 'video';
    lightbox.statsBtn.style.display = item.type === 'video' ? '' : 'none';
    lightbox.speed.style.display = item.type === 'video' ? '' : 'none';
    if (videoStatsEnabled && item.type === 'video') startVideoStats(); else stopVideoStats();
    if(item.type==='video')stopActivity=window.StreamActivity.bind(media,item);
    installMediaZoom(media);
    renderSavedEditor(item);
    if (bg && item.type === 'video') { bg.setHoverColor(item.color); bg.attachAudio(media); }
    updateBackgroundBusy();
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
    renderInfoPanel(lb.item);
  }

  function fetchNeighbors(id) {
    var params = new URLSearchParams();
    if (state.folder) params.set('folder', state.folder);
    params.set('sort', state.sort);
    if (state.sort === 'random' || state.sort === 'less-seen') params.set('seed', state.seed);
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
    var place = fromGrid ? rememberCurrentEntry() : history.state?.streamGallery;
    entrance?.dismissWelcome();
    if (!lb.open) lb.returnFocus = document.activeElement;
    if(lb.open)window.StreamActivity.record(lb.item,'close');
    window.StreamActivity.record(item,'open');
    lb.open = true;
    lb.openedFromGrid = fromGrid || history.state?.streamFromGallery === true;
    lb.item = item;
    document.body.classList.add('lb-open');
    runningPreviews.forEach(function (tile) { pausePreview(tile); });
    lightbox.root.classList.add('open');
    lightbox.root.inert = false;
    lightbox.root.setAttribute('aria-hidden', 'false');
    header.inert = true; main.inert = true; linksBottom.inert = true;
    lightbox.closeBtn.focus({ preventScroll: true });
    renderLightboxMedia(item);
    if (fromGrid) {
      history.pushState({ streamItem: item.id, streamFromGallery: true, streamGallery: place }, '', galleryAddress(item.id));
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
    stopVideoStats();
    releaseLightboxMedia();
    lb.open = false;
    updateBackgroundBusy();
    lightbox.root.classList.remove('open');
    document.body.classList.remove('lb-open');
    requestAnimationFrame(refillPreviews);
    if (bg) bg.detachAudio();
    lightbox.editPanel.classList.remove('open');
    lightbox.editBtn.classList.remove('active');
    lightbox.infoPanel.classList.remove('open');
    lightbox.infoBtn.classList.remove('active');
    header.inert = false; main.inert = false; linksBottom.inert = false;
    if (lb.returnFocus?.isConnected) lb.returnFocus.focus({ preventScroll: true });
    else header.querySelector('button')?.focus({ preventScroll: true });
    lightbox.root.inert = true;
    lightbox.root.setAttribute('aria-hidden', 'true');
  }

  function closeLightbox() {
    if (!lb.open) return;
    closeLightboxUI();
    if (lb.openedFromGrid) {
      history.back();
    } else if (location.pathname !== '/') {
      history.pushState({ streamGallery: currentFolderPlace(history.state?.streamGallery) }, '', galleryAddress(null));
    }
  }

  function navigate(dir, fromSlideshow) {
    var target = dir < 0 ? lb.prev : lb.next;
    if (!target) return;
    openLightbox(target, false);
    history.replaceState(Object.assign({}, history.state, { streamItem: target.id }), '', galleryAddress(target.id));
    if (fromSlideshow) scheduleSlideshowAdvance();
  }

  window.addEventListener('popstate', function () {
    stopSlideshow();
    var folder = new URLSearchParams(location.search).get('folder') || '';
    if (window.StreamFolders && folder !== (state.folder || '')) window.StreamFolders.select(folder, true);
    var pathname = location.pathname;
    var address = location.href;
    var m = pathname.match(/^\/([^/]+)$/);
    if (m && m[1]) {
      var id;
      try { id = decodeURIComponent(m[1]); } catch (_) { return; }
      if (lb.open && lb.item.id === id) return;
      fetchNeighbors(id).then(function (data) {
        if (location.href === address && data.item) openLightbox(data.item, false);
      }).catch(function () {});
    } else {
      closeLightboxUI();
    }
  });

  function seekVideo(seconds) {
    var video = lightbox.mediaWrap.querySelector('video');
    if (!video) return false;
    if (video.readyState > 0) {
      var start = video.seekable.length ? video.seekable.start(0) : 0;
      var end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.max(start, Math.min(end, video.currentTime + seconds));
    }
    return true;
  }

  document.addEventListener('keydown', function (e) {
    if (!lb.open || document.querySelector('dialog[open]')) return;
    if (e.key === 'Tab') return;
    if (e.key === 'Escape') { e.preventDefault(); stopSlideshow(); closeLightbox(); return; }
    if (e.target.closest('input,textarea,select,[contenteditable]') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var direction = e.key === 'ArrowLeft' ? -1 : 1;
      e.preventDefault();
      if (!seekVideo(direction * 10)) { stopSlideshow(); navigate(direction); }
    } else if (e.key === ' ' && !e.target.closest('button,a,video')) {
      var v = lightbox.mediaWrap.querySelector('video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
  });

  var touchStartX = null, multiTouch = false;
  lightbox.mediaWrap.addEventListener('touchstart', function (e) { multiTouch = e.touches.length > 1 || lightbox.mediaWrap.dataset.zoomed === 'true' || Boolean(e.target.closest('video,button,a,input,select')); touchStartX = multiTouch ? null : e.touches[0].clientX; }, { passive: true });
  lightbox.mediaWrap.addEventListener('touchend', function (e) {
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

  function buildSignInModal() {
    var setup = CONFIG.setupRequired;
    var scrim = el('div', { class: 'modal-scrim locked', 'aria-hidden': 'true' });
    scrim.inert = true;
    var card = el('form', { class: 'modal-card signin-card', 'aria-label': setup ? 'Set up owner' : 'Sign in' });
    card.appendChild(el('div', { class: 'modal-mark', 'aria-hidden': 'true' }));
    card.appendChild(el('p', { class: 'signin-eyebrow' }, 'Your media · Your machine'));
    var heading = el('h1');
    heading.textContent = CONFIG.title;
    card.appendChild(heading);
    var sub = el('p', { class: 'modal-sub' }, 'This stream is private. Sign in to continue.');
    sub.setAttribute('role', 'status');
    card.appendChild(sub);
    var userInput = CONFIG.loginNeedsUsername && !setup ? el('input', { type: 'text', name: 'username', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Username', required: '' }) : null;
    if (userInput) card.appendChild(userInput);
    var setupCode=null;if(setup){sub.textContent='Create your owner passphrase. Find the one-time setup code in the server logs (docker compose logs stream).';setupCode=el('input',{type:'password',placeholder:'Owner setup code','aria-label':'Owner setup code',autocomplete:'off'});card.appendChild(setupCode);}
    var input = el('input', { type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    input.setAttribute('aria-label','Password');if(setup){input.autocomplete='new-password';input.minLength=10;input.placeholder='New passphrase (10+ characters)';}
    card.appendChild(input);
    var submit = el('button', { type: 'submit' }, setup ? 'Create owner account' : 'Sign in');
    card.appendChild(submit);
    scrim.appendChild(card);

    function open() {
      scrim.inert = false;
      scrim.setAttribute('aria-hidden', 'false');
      scrim.classList.add('open');
      entrance?.signIn(card);
      setTimeout(function () { (userInput || setupCode || input).focus(); }, 50);
    }
    card.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') {
        var controls = Array.from(card.querySelectorAll('input, button')).filter(function (control) { return !control.disabled; });
        var first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = setup ? 'Creating owner…' : 'Signing in…';
      fetch(setup?'/api/setup':'/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: userInput?.value.trim(), password: input.value, code:setupCode?setupCode.value.trim():undefined }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.ok) { entrance?.state.signedIn(); location.reload(); return; }
          submit.disabled = false;
          submit.textContent = setup ? 'Create owner account' : 'Sign in';
          card.classList.add('modal-shake');
          sub.textContent = res.data.error || 'Sign-in failed.';
          input.value = '';
          input.focus();
          setTimeout(function () { card.classList.remove('modal-shake'); }, 400);
        })
        .catch(function () { submit.disabled = false; submit.textContent = setup ? 'Create owner account' : 'Sign in'; sub.textContent = 'Something went wrong. Try again.'; });
    });

    return { root: scrim, open: open };
  }


  measureColumns();

  foldersReady.then(function () {
    var entry = history.state || {};
    var place = currentFolderPlace(entry.streamGallery);
    applyGalleryPlace(place);
    var id = INITIAL_ITEM?.id;
    if (id || location.pathname === '/') {
      var next = { streamGallery: place };
      if (id) {
        next.streamItem = id;
        next.streamFromGallery = entry.streamFromGallery === true;
      }
      history.replaceState(next, '', galleryAddress(id));
    }
    if (INITIAL_ITEM) openLightbox(INITIAL_ITEM, false);
    return restoreGallery(place);
  });
  window.addEventListener('stream:scan-requested', fetchLibraryStatus);
  fetchLibraryStatus();
  window.StreamDashboardNotifications.poll();
  setInterval(function () {
    if (document.hidden) return;
    fetchLibraryStatus();
    window.StreamDashboardNotifications.poll();
    refreshPendingPreviews();
  }, 10000);
})();
