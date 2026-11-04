'use strict';

// Run with `node test/browser-regression.cjs`: this starts an isolated server
// with generated media, checks real Chromium interactions, then removes only
// its temporary test directory. It never reads the user's media or database.
// Set STREAM_PLAYWRIGHT to an installed Playwright module path when it is not
// available through the project's development dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.STREAM_PLAYWRIGHT || 'playwright');
const { checkDesignEntrance } = require('./design-browser-checks.cjs');
const { checkLongScroll } = require('./scroll-browser-checks.cjs');
const { checkFolderCollections } = require('./folders-browser-checks.cjs');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-browser-'));
const media = path.join(temp, 'media');
const runtime = path.join(temp, 'app');
const screenshotDirectory = process.env.STREAM_BROWSER_SCREENSHOTS;
const report = { checks: [], pageErrors: [], screenshots: [], retiredRequests: [] };
let child, browser, context, page, output = '';

async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw Error('Test server stopped: ' + output);
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw Error('Timed out: ' + message + '\n' + output.slice(-3000));
}
function tool(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}
async function json(url, data) {
  const response = data === undefined ? await context.request.get(url) : await context.request.post(url, { data });
  const value = await response.json();
  assert.ok(response.ok(), response.status() + ' ' + JSON.stringify(value));
  return value;
}
async function navDepth(value) { await page.waitForFunction(value => window.StreamNavigation.depth() === value, value); }
async function escapeToGallery() {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.lightbox.open') && !document.querySelector('dialog[open]') && location.pathname === '/');
}
async function openSettings(target = page) {
  await target.getByRole('button', { name: 'Settings', exact: true }).click();
  await target.waitForFunction(() => window.StreamNavigation.depth() === 1 && document.querySelector('dialog.stream-settings[open]'));
}
async function settingsSection(name) {
  await openSettings();
  await page.locator('#settings-' + name + ' > summary').click();
  await navDepth(2);
}
async function screenshot(target, name) {
  if (!screenshotDirectory) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  await target.evaluate(() => {
    getSelection()?.removeAllRanges(); document.activeElement?.blur();
    document.querySelector('.view-panel.open, dialog.stream-settings[open]')?.scrollTo(0, 0);
  });
  await target.waitForTimeout(250); // Allow theme/control color transitions to finish.
  const filename = path.join(screenshotDirectory, name + '.png');
  await target.screenshot({ path: filename });
  report.screenshots.push(filename);
}
async function assertFits(target, selector, description) {
  const layout = await target.locator(selector).evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, right: box.right, y: box.y, bottom: box.bottom,
      width: innerWidth, height: innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      documentWidth: document.documentElement.scrollWidth };
  });
  assert.ok(layout.x >= -1 && layout.right <= layout.width + 1 && layout.y >= -1 && layout.bottom <= layout.height + 1,
    description + ' fits its viewport: ' + JSON.stringify(layout));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1 && layout.documentWidth <= layout.width + 1,
    description + ' has no horizontal clipping: ' + JSON.stringify(layout));
}
async function range(target, label, value) {
  const slider = target.getByRole('slider', { name: label, exact: true });
  await slider.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
  assert.equal(await slider.inputValue(), String(value));
}

async function run() {
  // Isolate the application too, so its .env parser cannot read personal configuration.
  fs.mkdirSync(runtime);
  for (const directory of ['lib', 'public', 'scripts']) fs.cpSync(path.join(root, directory), path.join(runtime, directory), { recursive: true });
  for (const filename of ['server.js', 'package.json']) fs.copyFileSync(path.join(root, filename), path.join(runtime, filename));
  fs.mkdirSync(media);
  tool(['-f', 'lavfi', '-i', 'testsrc2=size=64x96:rate=24', '-t', '8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(media, 'sample.mp4')]);
  tool(['-f', 'lavfi', '-i', 'testsrc2=size=240x180:rate=1', '-frames:v', '1', '-threads', '1', path.join(temp, 'poster.jpg')]);
  for (let i = 0; i < 36; i++) {
    const folder = path.join(media, 'Artist-' + i % 4); fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(temp, 'poster.jpg'), path.join(folder, 'photo-' + i + '.jpg'));
    if (i < 16) fs.copyFileSync(path.join(media, 'sample.mp4'), path.join(folder, 'clip-' + i + '.mp4'));
  }
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const baseURL = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server.js'], {
    cwd: runtime,
    env: { PATH: process.env.PATH, TMPDIR: temp, NODE_DISCOVERY: '0', HOST: '127.0.0.1', PORT: String(port), MEDIA_DIR: media, CACHE_DIR: path.join(temp, 'cache'), DATA_DIR: path.join(temp, 'data'),
      ORIGINALS_DIR: path.join(temp, 'originals'), REQUIRE_LOGIN: '1', ADMIN_USERNAME: 'qa', ADMIN_PASSWORD: 'browser-regression-passphrase',
      SESSION_SECRET: 'browser-regression-session-secret-123456789', WATCH_FOR_CHANGES: '0', RESCAN_INTERVAL_MINUTES: '0',
      ENABLE_FACE_DETECTION: '0', ENABLE_PET_DETECTION: '0', ENABLE_OCR: '0', ENABLE_DUPLICATE_DETECTION: '0', ENABLE_OBJECT_DETECTION: '0',
      THUMBNAIL_SIZES: '240', LARGE_SIZES: '240', POSTER_SIZES: '96', VIDEO_PREVIEW_MAX_WIDTH: '64', PROCESSING_CONCURRENCY: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  await until(async () => { try { return (await fetch(baseURL + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'server health');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  await json('/api/login', { username: 'qa', password: 'browser-regression-passphrase' });
  await until(async () => { const status = await json('/api/library-status'); return !status.scanning && status.stats.videoCount === 17 && status.stats.photoCount === 36; }, 'generated library import', 60000);
  await checkDesignEntrance({ browser, baseURL, report });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  context.on('request', request => {
    const endpoint = new URL(request.url()).pathname;
    if (/^\/api\/enhancements(?:\/|$)/.test(endpoint) || /^\/api\/items\/[^/]+\/variants(?:\/|$)/.test(endpoint)) report.retiredRequests.push(request.url());
  });
  await page.addInitScript(() => localStorage.setItem('stream-max-previews', '8'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.video-tile').first().waitFor();
  const missingPage = await page.goto('/missing-media-branch-check', { waitUntil: 'domcontentloaded' });
  assert.equal(missingPage.status(), 404);
  await page.locator('.video-tile').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.ok((await page.getByRole('region', { name: 'Running application', exact: true }).innerText()).includes('Signed in as owner'));
  await page.getByRole('group', { name: 'Theme', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Enhance|Jobs/ }).count(), 0);
  await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('obsolete media links retain owner settings');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.video-tile').first().waitFor();
  const first = await page.locator('.video-tile').first().evaluate(tile => tile._item);
  await page.locator('.video-tile').first().click();
  await page.waitForFunction(() => document.querySelector('.lightbox video')?.readyState >= 1);
  const box = await page.locator('.lightbox-card').boundingBox();
  assert.ok(Math.abs(box.width - 1152) <= 1 && Math.abs(box.height - 720) <= 1, 'Viewer must remain 90% of the viewport: ' + JSON.stringify(box));
  report.player = box; report.checks.push('90% viewport player');
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForFunction(() => {
    const box = document.querySelector('.lightbox-card').getBoundingClientRect();
    return Math.abs(box.width - innerWidth * .9) <= 1 && Math.abs(box.height - innerHeight * .9) <= 1;
  });
  report.resizedPlayer = await page.locator('.lightbox-card').boundingBox();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => Number.isFinite(window.StreamDiagnostics.snapshot().firstPlayerFrame?.elapsedMs));
  const passive = await page.evaluate(() => window.StreamDiagnostics.snapshot());
  assert.ok(Number.isFinite(passive.firstVisibleLoadedThumbnailMs) && passive.firstVisibleLoadedThumbnailMs >= 0);
  assert.equal(passive.firstPlayerFrame.method, 'presented-frame callback');
  assert.ok(passive.recentCatalogResponses.length > 0 && passive.recentCatalogResponses.every(entry => Number.isFinite(entry.durationMs) && entry.durationMs >= 0));
  report.passiveTimings = passive; report.checks.push('player follows browser resize', 'passive useful-media/catalog measurements');
  await escapeToGallery();
  assert.equal(await page.locator('.lightbox video[src]').count(), 0, 'Closed player must release its source');

  await page.getByRole('button', { name: 'View options', exact: true }).click(); await navDepth(1);
  const size = page.getByRole('slider', { name: 'Media size', exact: true });
  assert.equal(await size.count(), 1, 'Media size has one direct slider');
  assert.ok(await size.evaluate(element => document.activeElement === element), 'View options focuses its immediate size control');
  assert.equal(await page.getByRole('button', { name: /^(Layout|Playback|Filters) ›$/ }).count(), 0);
  await range(page, 'Media size', 240);
  const defaultSpacing = await page.locator('#grid').evaluate(grid => { const style = getComputedStyle(grid); return [style.rowGap, style.columnGap, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]; });
  assert.deepEqual(defaultSpacing, ['0px', '0px', '0px', '0px', '0px', '0px'], 'The default gallery remains zero-gutter');
  await page.getByRole('button', { name: 'Fine borders', exact: true }).click();
  assert.equal(await page.locator('.artist-outline-layer').count(), 0);
  assert.equal(await page.locator('#grid').evaluate(grid => grid.dataset.artistOutlines), 'subtle');
  const gallerySpacing = await page.locator('#grid').evaluate(grid => { const style = getComputedStyle(grid); return [style.rowGap, style.columnGap, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]; });
  assert.deepEqual(gallerySpacing, ['1px', '1px', '1px', '1px', '1px', '1px'], 'Optional fine borders keep one-pixel gallery spacing');
  assert.equal(await page.evaluate(() => localStorage.getItem('stream-tile-size')), '240');
  await screenshot(page, 'desktop-view-options');
  await page.keyboard.press('Escape'); await navDepth(0);
  assert.ok(await page.getByRole('button', { name: 'View options', exact: true }).evaluate(element => document.activeElement === element));
  await page.goForward(); await navDepth(1);
  assert.equal(await size.inputValue(), '240');
  await page.locator('details.view-advanced > summary').click(); await navDepth(1);
  await page.getByLabel('Saved view name', { exact: true }).fill('Regression view');
  await page.getByRole('button', { name: 'Save current view', exact: true }).click();
  assert.ok(await page.getByLabel('Saved views', { exact: true }).locator('option').count() > 1);
  await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('flat View options and one persistent size slider', 'tile-local outlines and zero-gutter gallery', 'options focus and Back/Forward', 'saved views in native More controls');

  await page.keyboard.press('/'); await navDepth(1);
  await page.locator('dialog.stream-settings[open]').waitFor();
  for (const name of ['Appearance', 'Video player', 'Library', 'Access']) assert.ok(await page.getByRole('heading', { name, exact: true }).isVisible());
  const theme = page.getByRole('group', { name: 'Theme', exact: true });
  const effects = page.getByRole('group', { name: 'Visual effects', exact: true });
  await theme.getByRole('button', { name: 'Light', exact: true }).click();
  await effects.getByRole('button', { name: 'Subtle', exact: true }).click();
  await range(page, 'Viewer background blur', 17);
  await page.getByRole('checkbox', { name: 'Show Stats for nerds in video player', exact: true }).check();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--viewer-blur').trim()), '17px');
  const buildInfo = page.getByRole('region', { name: 'Running application', exact: true });
  assert.ok((await buildInfo.innerText()).includes(require('../package.json').version));
  assert.ok((await buildInfo.innerText()).includes('Signed in as owner'));
  assert.ok((await buildInfo.innerText()).includes(baseURL));
  assert.equal(await page.locator('.settings-category').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Enhance|Jobs/ }).count(), 0);
  await screenshot(page, 'desktop-settings');
  await page.keyboard.press('Escape'); await navDepth(0);
  await openSettings();
  assert.equal(await theme.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await effects.getByRole('button', { name: 'Subtle', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('slider', { name: 'Viewer background blur', exact: true }).inputValue(), '17');
  assert.equal(await page.getByRole('checkbox', { name: 'Show Stats for nerds in video player', exact: true }).isChecked(), true);
  const preferences = await page.evaluate(() => Object.fromEntries(['stream-effects', 'stream-viewer-blur', 'stream-video-stats'].map(key => [key, localStorage.getItem(key)])));
  assert.deepEqual(preferences, { 'stream-effects': 'subtle', 'stream-viewer-blur': '17', 'stream-video-stats': '1' });
  const settings = await json('/api/settings');
  for (const key of Object.keys(preferences)) assert.equal(settings.ui?.[key], undefined, key + ' remains browser-local');
  report.checks.push('direct Appearance/player/library/access cards and keyboard shortcut', 'visible running version, server address and owner state', 'persistent browser-local blur, effects and Stats');

  await page.locator('#settings-maintenance > summary').click(); await navDepth(2);
  await page.locator('#settings-history > summary').click(); await navDepth(2);
  await page.waitForFunction(() => document.querySelectorAll('.settings-detail[open]').length === 1 && document.querySelector('#settings-history').open);
  assert.equal(await page.locator('.settings-detail[open]').count(), 1, 'Advanced cards form one accordion');
  assert.equal(await page.locator('#settings-history').getAttribute('open'), '');
  await page.keyboard.press('Escape'); await navDepth(1);
  assert.equal(await page.locator('.settings-detail[open]').count(), 0);
  assert.ok(await page.locator('#settings-history > summary').evaluate(element => document.activeElement === element), 'Back focuses the advanced summary');
  await page.goForward(); await navDepth(2);
  assert.equal(await page.locator('#settings-history').getAttribute('open'), '', 'Forward restores the last advanced card');
  await page.goBack(); await navDepth(1); await page.goBack(); await navDepth(0);
  await page.goForward(); await navDepth(1); await page.goForward(); await navDepth(2);
  assert.equal(await page.locator('#settings-history').getAttribute('open'), '');
  // A native dialog close event is queued. Model its late delivery after
  // Forward has already reopened the same Settings dialog and detail.
  const lateClose = await page.evaluate(() => {
    const current = document.querySelector('dialog.stream-settings[open]');
    const pane = current.querySelector('#settings-history > .settings-detail-content');
    const navigation = window.StreamNavigation, leave = navigation.leave, leaves = [];
    navigation.leave = function (id) { leaves.push(id); return leave.apply(this, arguments); };
    try { current.dispatchEvent(new Event('close')); }
    finally { navigation.leave = leave; }
    return { leaves, depth: navigation.depth(), dialogOpen: current.open,
      detailOpen: current.querySelector('#settings-history').open,
      samePane: pane === current.querySelector('#settings-history > .settings-detail-content') && pane.isConnected };
  });
  assert.deepEqual(lateClose, { leaves: [], depth: 2, dialogOpen: true, detailOpen: true, samePane: true },
    'A late close event cannot unwind reopened Settings or discard its active pane');
  await page.goBack(); await navDepth(1); await page.goForward(); await navDepth(2);
  assert.equal(await page.locator('#settings-history').getAttribute('open'), '', 'Legitimate Back/Forward still works after a stale close event');
  await page.keyboard.press('Escape'); await navDepth(1); await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('advanced accordion shares one Settings history level', 'Settings keyboard focus and Back/Forward restore the last detail', 'stale dialog close events preserve restored Settings and advanced panes');

  await page.getByRole('button', { name: 'View options', exact: true }).click(); await navDepth(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await navDepth(1);
  await page.locator('dialog.stream-settings[open]').waitFor();
  assert.equal(await page.locator('.view-panel.open').count(), 0);
  const previousSettings = await page.locator('dialog.stream-settings[open]').elementHandle();
  await page.keyboard.press('Escape'); await navDepth(0);
  await openSettings();
  const removedDialogClose = await previousSettings.evaluate(previous => {
    const current = document.querySelector('dialog.stream-settings[open]');
    const navigation = window.StreamNavigation, leave = navigation.leave, leaves = [];
    navigation.leave = function (id) { leaves.push(id); return leave.apply(this, arguments); };
    try { previous.dispatchEvent(new Event('close')); }
    finally { navigation.leave = leave; }
    return { leaves, depth: navigation.depth(), dialogOpen: current.open,
      sameDialog: current === document.querySelector('dialog.stream-settings[open]'),
      previousRemoved: !previous.isConnected && previous !== current };
  });
  assert.deepEqual(removedDialogClose, { leaves: [], depth: 1, dialogOpen: true, sameDialog: true, previousRemoved: true },
    'A removed Settings instance cannot close or unwind a newer dialog');
  await previousSettings.dispose();
  await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('one-click View options to Settings handoff', 'removed Settings instance close events preserve the current dialog');
  await page.getByRole('combobox', { name: 'Filter by type', exact: true }).selectOption('photo');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0 && !document.querySelector('.video-tile'));
  assert.equal(await page.locator('.tile video[src]').count(), 0, 'Filter reset must release preview sources');
  await page.getByRole('combobox', { name: 'Filter by type', exact: true }).selectOption('');
  await page.locator('.video-tile').first().waitFor();
  await page.mouse.move(1200, 600); await page.mouse.wheel(0, 10000);
  await until(async () => await page.locator('.tile video[src]').count() <= 8, 'offscreen source release');
  report.retainedPreviewSources = await page.locator('.tile video[src]').count();
  report.checks.push('filter cleanup', 'offscreen preview source budget');
  await checkLongScroll({ page, context, report });

  await page.getByRole('button', { name: 'View options', exact: true }).click(); await navDepth(1);
  if (await page.locator('details.view-advanced').getAttribute('open') === null) await page.locator('details.view-advanced > summary').click();
  await navDepth(1);
  await page.getByRole('button', { name: 'Check playback smoothness', exact: true }).click();
  const diagnosticOutput = page.getByLabel('Copyable diagnostic results', { exact: true });
  await diagnosticOutput.waitFor({ timeout: 10000 });
  const diagnostic = JSON.parse(await diagnosticOutput.inputValue());
  assert.ok(diagnostic.valid);
  assert.ok(Number.isFinite(diagnostic.pageCallbackFps) && diagnostic.pageCallbackFps > 0);
  assert.ok(Number.isFinite(diagnostic.p95FrameIntervalMs));
  assert.ok(diagnostic.note.includes('not physical display output'));
  assert.ok(diagnostic.passiveTimings.recentCatalogResponses.length > 0);
  await page.getByRole('dialog', { name: 'Playback diagnostics', exact: true }).getByRole('button', { name: 'Close', exact: true }).click(); await navDepth(0);
  report.checks.push('six-second scheduling diagnostics');

  await settingsSection('maintenance');
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.locator('#settings-maintenance pre').first().filter({ hasText: 'queued' }).waitFor();
  const work = await json('/api/work'); assert.ok(Array.isArray(work.work.active) && Array.isArray(work.work.queued));
  await page.getByRole('button', { name: 'Measure storage', exact: true }).click();
  await page.locator('#settings-maintenance pre').filter({ hasText: 'Original media:' }).waitFor();
  report.checks.push('maintenance work/storage status');
  await page.keyboard.press('Escape'); await navDepth(1); await page.keyboard.press('Escape'); await navDepth(0);

  assert.equal(await page.getByRole('button', { name: /Enhance video|Enhance|Jobs/ }).count(), 0);
  await page.locator('.video-tile').evaluateAll((tiles, id) => tiles.find(tile => tile._item.id === id).click(), first.id);
  await page.waitForFunction(() => document.querySelector('.lightbox.open video')?.readyState >= 1);
  await page.locator('.video-stats').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enhance video', exact: true }).count(), 0);
  await escapeToGallery();
  assert.equal(await page.locator('.lightbox video[src]').count(), 0);
  report.checks.push('Stats preference applies to player and player cleanup', 'retired enhancement controls stay absent');

  const touchContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await touchContext.addCookies(await context.cookies());
  const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => report.pageErrors.push(error.message));
  await touchPage.goto('/', { waitUntil: 'domcontentloaded' });
  await touchPage.locator('.video-tile').first().tap();
  await touchPage.waitForFunction(() => document.querySelector('.lightbox.open video')?.readyState >= 1);
  const touchBox = await touchPage.locator('.lightbox-card').boundingBox();
  assert.ok(Math.abs(touchBox.width - 351) <= 1 && Math.abs(touchBox.height - 759.6) <= 1, 'Touch viewer must fit the viewport: ' + JSON.stringify(touchBox));
  await touchPage.locator('.lightbox.open').tap({ position: { x: 4, y: 400 } });
  await touchPage.waitForFunction(() => !document.querySelector('.lightbox.open'));
  await openSettings(touchPage);
  await touchPage.getByRole('slider', { name: 'Viewer background blur', exact: true }).waitFor();
  await touchPage.getByRole('button', { name: 'Close settings', exact: true }).tap();
  await touchPage.waitForFunction(() => window.StreamNavigation.depth() === 0);
  await touchContext.close();
  report.touchPlayer = touchBox; report.checks.push('touch player/open-close and direct Settings');

  for (const width of [320, 390, 640]) {
    const responsive = await browser.newContext({ baseURL, viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await responsive.addCookies(await context.cookies());
    const screen = await responsive.newPage();
    screen.on('pageerror', error => report.pageErrors.push(error.message));
    await screen.goto('/', { waitUntil: 'domcontentloaded' });
    await screen.locator('#grid .tile').first().waitFor();
    const welcome = screen.getByRole('button', { name: 'Dismiss welcome', exact: true });
    if (await welcome.count()) await welcome.click();
    await openSettings(screen);
    await assertFits(screen, 'dialog.stream-settings[open]', width + 'px Settings');
    const themeOverflow = await screen.locator('.settings-theme-choices .settings-choice').evaluateAll(buttons => buttons.filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.textContent));
    assert.deepEqual(themeOverflow, [], width + 'px theme labels do not clip');
    if (width === 320) await screenshot(screen, 'mobile-320-settings');
    await screen.keyboard.press('Escape'); await screen.waitForFunction(() => window.StreamNavigation.depth() === 0);
    await screen.getByRole('button', { name: 'View options', exact: true }).click();
    await screen.waitForFunction(() => window.StreamNavigation.depth() === 1);
    await assertFits(screen, '.view-panel.open', width + 'px View options');
    assert.equal(await screen.getByRole('slider', { name: 'Media size', exact: true }).count(), 1);
    if (width === 320 || width === 640) await screenshot(screen, width === 320 ? 'mobile-320-view-options' : 'tablet-640-view-options');
    await screen.locator('details.view-advanced > summary').click();
    await assertFits(screen, '.view-panel.open', width + 'px expanded View options');
    await screen.getByLabel('Saved view name', { exact: true }).scrollIntoViewIfNeeded();
    assert.ok(await screen.getByLabel('Saved view name', { exact: true }).isVisible());
    await responsive.close();
  }
  report.checks.push('320/390/640px Settings and View options fit without clipped controls', 'mobile theme labels and expanded More controls remain reachable');
  await checkFolderCollections({ browser, baseURL, report, media });
  assert.deepEqual(report.retiredRequests, [], 'Settings, View options and player never request retired enhancement APIs');
  assert.deepEqual(report.pageErrors, []);
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    const clean = await Promise.race([exit.then(() => true), delay(10000, undefined, { ref: false }).then(() => false)]);
    if (!clean && child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
