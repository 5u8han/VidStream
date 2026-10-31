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

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-browser-'));
const media = path.join(temp, 'media');
const report = { checks: [], pageErrors: [] };
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
async function settingsSection(name) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await navDepth(1);
  await page.locator('.settings-category[aria-controls="settings-' + name + '"]').click();
  await navDepth(2);
}
async function waitJob(itemId, preview) {
  return until(async () => {
    const data = await json('/api/enhancements?item=' + encodeURIComponent(itemId));
    const job = data.jobs.find(job => Boolean(job.options.preview) === preview);
    if (job && ['paused', 'failed', 'cancelled'].includes(job.state)) throw Error('Enhancement failed: ' + JSON.stringify(job));
    return job?.state === 'completed' ? job : null;
  }, (preview ? 'sample' : 'full') + ' enhancement completion', 60000);
}

async function run() {
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
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MEDIA_DIR: media, CACHE_DIR: path.join(temp, 'cache'), DATA_DIR: path.join(temp, 'data'),
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
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('stream-max-previews', '8'));
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
  await page.getByRole('button', { name: 'Layout ›', exact: true }).click(); await navDepth(2);
  await page.getByRole('button', { name: 'Fine tile borders', exact: true }).click();
  assert.equal(await page.locator('.artist-outline-layer').count(), 0);
  assert.equal(await page.locator('#grid').evaluate(grid => grid.dataset.artistOutlines), 'subtle');
  await page.keyboard.press('Escape'); await navDepth(1); await page.goForward(); await navDepth(2); await page.goBack(); await navDepth(1);
  await page.getByRole('button', { name: 'Filters ›', exact: true }).click(); await navDepth(2);
  await page.getByLabel('Saved view name', { exact: true }).fill('Regression view');
  await page.getByRole('button', { name: 'Save current view', exact: true }).click();
  assert.ok(await page.getByLabel('Saved views', { exact: true }).locator('option').count() > 1);
  await page.keyboard.press('Escape'); await navDepth(1); await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('tile-local outlines', 'options Back/Forward', 'saved views');

  await settingsSection('view'); await page.keyboard.press('Escape'); await navDepth(1); await page.goForward(); await navDepth(2);
  await page.keyboard.press('Escape'); await navDepth(1); await page.keyboard.press('Escape'); await navDepth(0);
  report.checks.push('settings Back/Forward');
  await page.getByRole('combobox', { name: 'Filter by type', exact: true }).selectOption('photo');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0 && !document.querySelector('.video-tile'));
  assert.equal(await page.locator('.tile video[src]').count(), 0, 'Filter reset must release preview sources');
  await page.getByRole('combobox', { name: 'Filter by type', exact: true }).selectOption('');
  await page.locator('.video-tile').first().waitFor();
  await page.mouse.move(1200, 600); await page.mouse.wheel(0, 10000);
  await until(async () => await page.locator('.tile video[src]').count() <= 8, 'offscreen source release');
  report.retainedPreviewSources = await page.locator('.tile video[src]').count();
  report.checks.push('filter cleanup', 'offscreen preview source budget');

  await page.getByRole('button', { name: 'View options', exact: true }).click(); await navDepth(1);
  await page.getByRole('button', { name: 'Playback ›', exact: true }).click(); await navDepth(2);
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

  await page.locator('.video-tile').evaluateAll((tiles, id) => tiles.find(tile => tile._item.id === id).click(), first.id);
  await page.getByRole('button', { name: 'Enhance video', exact: true }).click(); await navDepth(1);
  await page.getByRole('button', { name: 'Estimate full job', exact: true }).click();
  await page.getByRole('button', { name: 'Render 5-second sample', exact: true }).click();
  const sample = await waitJob(first.id, true); assert.ok(sample.options.preview); assert.ok(sample.duration <= 5);
  const sampleCard = page.locator('dialog[open] article').filter({ has: page.locator('strong', { hasText: 'Sample · completed' }) });
  await sampleCard.getByRole('button', { name: 'Compare original / result', exact: true }).click();
  assert.equal(await page.locator('.enhancement-comparison video').count(), 2);
  assert.equal(await sampleCard.getByRole('button', { name: 'Approve & use by default', exact: true }).count(), 0, 'Samples must not be activatable as full media');
  await page.getByRole('button', { name: 'Queue full video', exact: true }).click();
  const full = await waitJob(first.id, false); assert.ok(!full.options.preview);
  const fullCard = page.locator('dialog[open] article').filter({ has: page.locator('strong', { hasText: 'Full version · completed' }) });
  await fullCard.getByRole('button', { name: 'Approve & use by default', exact: true }).click();
  await until(async () => (await json('/api/items/' + first.id + '/variants')).item.activeVariant === full.id, 'approved active version');
  await page.keyboard.press('Escape'); await navDepth(0);
  await page.waitForFunction(() => !document.querySelector('.enhancement-comparison video[src]'));
  assert.equal(await page.locator('.enhancement-comparison video[src]').count(), 0, 'Closed comparison must release both sources');
  await escapeToGallery();
  report.checks.push('short CPU sample', 'original/result comparison', 'full-version approval', 'modal source cleanup');

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
  await touchPage.getByRole('button', { name: 'Settings', exact: true }).tap();
  await touchPage.locator('.settings-category[aria-controls="settings-view"]').tap();
  await touchPage.getByRole('button', { name: 'Back to settings', exact: true }).tap();
  await touchPage.getByRole('button', { name: 'Close settings', exact: true }).tap();
  await touchPage.waitForFunction(() => window.StreamNavigation.depth() === 0);
  await touchContext.close();
  report.touchPlayer = touchBox; report.checks.push('touch player/open-close and nested settings');
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
