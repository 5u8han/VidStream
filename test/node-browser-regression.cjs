'use strict';

// `node test/node-browser-regression.cjs` starts two isolated local servers,
// checks node switching in Chromium, then stops them and removes only its
// generated temporary fixtures. It never reads personal media, .env values,
// application data or Docker volumes. FFmpeg and Playwright are required.
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
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-node-browser-'));
const runtime = path.join(fixture, 'app');
const report = { checks: [], pageErrors: [] };
const servers = [];
let browser, context, page;

async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(75);
  }
  throw Error('Timed out: ' + message + '\n' + servers.map(server => server.output.slice(-2000)).join('\n'));
}
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}
async function availablePort() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
async function createServer(name, filename, password, fixedPort) {
  const directory = path.join(fixture, name), media = path.join(directory, 'media');
  fs.mkdirSync(media, { recursive: true });
  fs.copyFileSync(path.join(fixture, 'photo.jpg'), path.join(media, filename + '.jpg'));
  fs.copyFileSync(path.join(fixture, 'clip.mp4'), path.join(media, filename + '.mp4'));
  const port = fixedPort || await availablePort();
  const server = { directory, media, port, url: 'http://127.0.0.1:' + port, password, output: '', child: null };
  servers.push(server);
  server.start = async () => {
    server.child = spawn(process.execPath, [path.join(runtime, 'server.js')], {
      cwd: runtime,
      env: { PATH: process.env.PATH, TMPDIR: fixture,
        HOST: '127.0.0.1', PORT: String(port), TITLE: name,
        MEDIA_DIR: media, CACHE_DIR: path.join(directory, 'cache'), DATA_DIR: path.join(directory, 'data'),
        ORIGINALS_DIR: path.join(directory, 'originals'), REQUIRE_LOGIN: '1', ADMIN_USERNAME: 'qa', ADMIN_PASSWORD: password,
        SESSION_SECRET: 'node-browser-' + name + '-private-session-secret-123456789',
        NODE_DISCOVERY: '0', WATCH_FOR_CHANGES: '0', RESCAN_INTERVAL_MINUTES: '0',
        ENABLE_FACE_DETECTION: '0', ENABLE_PET_DETECTION: '0', ENABLE_OCR: '0', ENABLE_DUPLICATE_DETECTION: '0', ENABLE_OBJECT_DETECTION: '0',
        THUMBNAIL_SIZES: '240', LARGE_SIZES: '240', POSTER_SIZES: '96', VIDEO_PREVIEW_MAX_WIDTH: '64', PROCESSING_CONCURRENCY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.child.stdout.on('data', value => { server.output += value; });
    server.child.stderr.on('data', value => { server.output += value; });
    await until(async () => {
      assert.equal(server.child.exitCode, null, server.output);
      try { return (await fetch(server.url + '/health', { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    }, name + ' health');
  };
  server.stop = async () => {
    const child = server.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    const clean = await Promise.race([exit.then(() => true), delay(10000, undefined, { ref: false }).then(() => false)]);
    if (!clean && child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  };
  await server.start();
  return server;
}
async function json(server, endpoint, data, request = context.request) {
  const response = data === undefined
    ? await request.get(server.url + endpoint)
    : await request.post(server.url + endpoint, { data });
  const value = await response.json();
  assert.ok(response.ok(), endpoint + ': ' + response.status() + ' ' + JSON.stringify(value));
  return value;
}
async function catalog(server, request = context.request) {
  const data = await json(server, '/api/items', undefined, request);
  return data.items.map(item => item.filename).sort();
}
async function gallery(target = page) {
  await target.locator('#grid .tile').first().waitFor();
  await target.waitForFunction(() => !document.querySelector('#grid').getAttribute('aria-busy') || document.querySelector('#grid').getAttribute('aria-busy') === 'false');
}
async function openNodesSettings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-category[aria-controls="settings-nodes"]').click();
  await page.getByLabel('Other library address', { exact: true }).waitFor();
}
async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.StreamNavigation.depth() === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.StreamNavigation.depth() === 0);
}
async function switcher(target = page) {
  const button = target.getByRole('button', { name: 'Switch library', exact: true });
  await button.click();
  await target.waitForFunction(() => document.querySelector('[aria-label="Switch library"]').getAttribute('aria-expanded') === 'true');
  return button;
}

async function run() {
  // Copy only application source/assets. In particular, do not copy .env,
  // media, cache, data, node_modules, Git state or any persistent volumes.
  fs.mkdirSync(runtime);
  for (const directory of ['lib', 'public', 'scripts']) fs.cpSync(path.join(root, directory), path.join(runtime, directory), { recursive: true });
  for (const filename of ['server.js', 'package.json']) fs.copyFileSync(path.join(root, filename), path.join(runtime, filename));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=240x180:rate=1', '-frames:v', '1', '-threads', '1', path.join(fixture, 'photo.jpg')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x96:rate=24', '-t', '2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(fixture, 'clip.mp4')]);
  const a = await createServer('Wedding NAS', 'wedding-memory', 'node-a-browser-passphrase');
  const b = await createServer('Reels Legion', 'reels-collection', 'node-b-browser-passphrase');
  const expectedA = ['wedding-memory.jpg', 'wedding-memory.mp4'];
  const expectedB = ['reels-collection.jpg', 'reels-collection.mp4'];
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });

  for (const server of [a, b]) {
    const descriptor = await json(server, '/api/node-info');
    assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'name', 'product', 'protocol']);
    assert.equal(descriptor.product, 'VidStream'); assert.equal(descriptor.protocol, 1);
    assert.match(descriptor.id, /^[a-f0-9-]{36}$/i);
    server.id = descriptor.id;
    const privateDirectory = await context.request.get(server.url + '/api/nodes');
    assert.equal(privateDirectory.status(), 401, 'Locked directory is not public');
    const privateCatalog = await context.request.get(server.url + '/api/items');
    assert.equal(privateCatalog.status(), 401, 'Discovery cannot grant media access');
  }
  assert.notEqual(a.id, b.id);
  report.checks.push('minimal public descriptors and independent persistent identities', 'locked peer directories and catalogs remain private');

  // Configure B through a separate owner's browser. The viewer below is still
  // signed out of B, so its first switch must pass B's own sign-in screen.
  const ownerB = await browser.newContext();
  await json(b, '/api/login', { username: 'qa', password: b.password }, ownerB.request);
  await json(b, '/api/nodes/settings', { name: 'Reels Legion', url: b.url, discoveryEnabled: false }, ownerB.request);
  await until(async () => {
    const status = await json(b, '/api/library-status', undefined, ownerB.request);
    return !status.scanning && status.stats.photoCount === 1 && status.stats.videoCount === 1;
  }, 'B generated media import');
  assert.deepEqual(await catalog(b, ownerB.request), expectedB);
  await ownerB.close();

  await json(a, '/api/login', { username: 'qa', password: a.password });
  await until(async () => {
    const status = await json(a, '/api/library-status');
    return !status.scanning && status.stats.photoCount === 1 && status.stats.videoCount === 1;
  }, 'A generated media import');
  assert.deepEqual(await catalog(a), expectedA);
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(a.url, { waitUntil: 'domcontentloaded' }); await gallery();
  await openNodesSettings();
  await page.getByLabel('Library name', { exact: true }).fill('Wedding NAS');
  await page.getByLabel('This library address', { exact: true }).fill(a.url);
  await page.getByRole('button', { name: 'Save library settings', exact: true }).click();
  await until(async () => (await json(a, '/api/nodes')).self.url === a.url, 'A public address saved');
  await page.getByLabel('Other library address', { exact: true }).fill(b.url);
  await page.getByRole('button', { name: 'Check library', exact: true }).click();
  await page.getByRole('button', { name: 'Add to switcher', exact: true }).click();
  await until(async () => (await json(a, '/api/nodes')).peers.some(peer => peer.id === b.id && peer.url === b.url), 'Verified peer saved');
  await closeSettings();
  report.checks.push('manual address verification and owner-approved saved switcher entry', 'separate catalogs retain their own media');

  const trigger = await switcher();
  const bounds = await trigger.boundingBox();
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 640) <= 24, 'Switcher stays near the top center');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Switch library"]').getAttribute('aria-expanded') === 'false');
  await switcher();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('link', { name: 'Open Reels Legion', exact: true }).click(),
  ]);
  assert.equal(new URL(page.url()).origin, b.url);
  await page.getByLabel('Username', { exact: true }).waitFor();
  const lockedHome = page.getByRole('link', { name: 'Return to linked library', exact: true });
  await lockedHome.waitFor();
  assert.equal(new URL(await lockedHome.getAttribute('href')).origin, a.url);
  assert.equal(new URL(page.url()).hash, '', 'Navigation bookmark is consumed without entering the server request or staying in the address bar');
  report.checks.push('center switcher keyboard dismissal', 'direct peer navigation keeps peer authentication intact', 'unverified return address remains reachable from a locked destination');

  await page.getByLabel('Username', { exact: true }).fill('qa');
  await page.getByLabel('Password', { exact: true }).fill(b.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await gallery();
  assert.deepEqual(await page.locator('#grid .tile').evaluateAll(tiles => tiles.map(tile => tile._item.filename).sort()), expectedB);
  await page.locator('.video-tile').first().click();
  await page.waitForFunction(() => document.querySelector('.lightbox.open video')?.readyState >= 1);
  assert.equal(await page.locator('.lightbox.open video').evaluate(video => new URL(video.currentSrc).origin), b.url, 'Media streams directly from the selected machine');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.lightbox.open'));
  await switcher();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('link', { name: 'Return to linked library', exact: true }).click(),
  ]);
  await gallery();
  assert.equal(new URL(page.url()).origin, a.url);
  assert.deepEqual(await catalog(a), expectedA);
  assert.deepEqual(await catalog(b), expectedB);
  const sessionCookies = (await context.cookies()).filter(cookie => cookie.name.startsWith('stream_session'));
  assert.ok(new Set(sessionCookies.map(cookie => cookie.name)).size >= 2, 'Each same-host instance has its own session cookie name');
  report.checks.push('selected machine serves its own media directly', 'same-host different-port sessions coexist without sharing credentials');

  await b.stop();
  await json(a, '/api/nodes/refresh', {});
  await until(async () => {
    const state = await json(a, '/api/nodes');
    return !state.refreshing && state.peers.some(peer => peer.id === b.id && peer.online === false);
  }, 'Offline peer retained', 20000);
  assert.deepEqual(await catalog(a), expectedA, 'An offline peer does not affect the local catalog');
  await b.start();
  assert.equal((await json(b, '/api/node-info')).id, b.id, 'Peer identity survives a process restart');
  await json(a, '/api/nodes/refresh', {});
  await until(async () => {
    const state = await json(a, '/api/nodes');
    return !state.refreshing && state.peers.some(peer => peer.id === b.id && peer.online === true);
  }, 'Restarted peer becomes reachable', 20000);
  assert.deepEqual(await catalog(b), expectedB);
  report.checks.push('offline peers stay saved while the local library works', 'peer restart retains identity, catalog and remembered login');

  // A different instance reusing the same network address must not silently
  // inherit the saved connection, its friendly label or its authentication.
  await b.stop();
  const replacement = await createServer('Replacement host', 'replacement-library', 'node-c-browser-passphrase', b.port);
  const replacementId = (await json(replacement, '/api/node-info')).id;
  assert.notEqual(replacementId, b.id);
  await json(a, '/api/nodes/refresh', {});
  await until(async () => {
    const state = await json(a, '/api/nodes');
    return !state.refreshing && state.peers.some(peer => peer.id === b.id && peer.status === 'identity-changed' && peer.online === false);
  }, 'Changed host identity is flagged', 20000);
  await switcher();
  await page.locator('#node-library-list').getByText(/Identity changed/).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open Reels Legion', exact: true }).count(), 0, 'Known identity mismatch cannot be opened as the saved node');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.StreamNavigation.depth() === 0);
  const staleApproval = await context.request.post(a.url + '/api/nodes/add', { data: { url: b.url, expectedId: b.id } });
  assert.equal(staleApproval.status(), 409, 'Approval for the old identity cannot accept its replacement');
  const directoryAfterReplacement = await json(a, '/api/nodes');
  assert.deepEqual(directoryAfterReplacement.peers.map(peer => peer.id), [b.id]);
  assert.equal((await context.request.get(replacement.url + '/api/items')).status(), 401, 'Old instance cookies do not authenticate to a replacement');
  await replacement.stop(); await b.start();
  await json(a, '/api/nodes/refresh', {});
  await until(async () => {
    const state = await json(a, '/api/nodes');
    return !state.refreshing && state.peers.some(peer => peer.id === b.id && peer.online === true);
  }, 'Original node restored after identity mismatch', 20000);
  report.checks.push('address reuse flags identity changes and blocks the saved navigation link', 'stale approvals and old cookies cannot join or authenticate a replacement node');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Switch library', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Node header does not create horizontal page overflow on phones');
  await switcher();
  await page.getByRole('link', { name: 'Open Reels Legion', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.StreamNavigation.depth() === 0);
  report.checks.push('phone-width switcher remains usable without horizontal overflow');

  await openNodesSettings();
  await page.getByRole('button', { name: 'Remove Reels Legion', exact: true }).click();
  await until(async () => !(await json(a, '/api/nodes')).peers.some(peer => peer.id === b.id), 'Connection removed');
  assert.deepEqual(await catalog(b), expectedB, 'Removing a connection does not change the other library');
  assert.deepEqual(fs.readdirSync(b.media).sort(), expectedB);
  assert.deepEqual(await catalog(a), expectedA);
  report.checks.push('removing a connection preserves both media folders and catalogs');

  // A URL fragment is an untrusted, temporary return hint. It must not turn an
  // arbitrary host into a durable or authoritative starting-library bookmark.
  const linkedOrigin = 'https://unrelated.example';
  const hinted = await browser.newContext({
    viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce',
    storageState: { cookies: await context.cookies(), origins: [] },
  });
  let externalRequests = 0;
  await hinted.route(linkedOrigin + '/**', route => { externalRequests++; return route.abort(); });
  try {
    const hintedPage = await hinted.newPage();
    hintedPage.on('pageerror', error => report.pageErrors.push(error.message));
    await hintedPage.goto(a.url + '/#vidstream-home=' + encodeURIComponent(linkedOrigin), { waitUntil: 'domcontentloaded' });
    await gallery(hintedPage);
    assert.equal(new URL(hintedPage.url()).hash, '');
    assert.equal(await hintedPage.evaluate(() => Object.values(localStorage).some(value => String(value).includes('unrelated.example'))), false, 'A fragment does not persist the supplied host in localStorage');
    await switcher(hintedPage);
    const temporaryReturn = hintedPage.getByRole('link', { name: 'Return to linked library', exact: true });
    await temporaryReturn.waitFor();
    assert.ok((await temporaryReturn.innerText()).includes('unrelated.example'), 'The neutral link displays its actual destination host');
    assert.equal(new URL(await temporaryReturn.getAttribute('href')).origin, linkedOrigin);
    assert.equal(await hintedPage.getByRole('link', { name: 'Return to starting library', exact: true }).count(), 0, 'Unverified input is not labeled as an authoritative starting library');

    const freshTab = await hinted.newPage();
    freshTab.on('pageerror', error => report.pageErrors.push(error.message));
    await freshTab.goto(a.url, { waitUntil: 'domcontentloaded' }); await gallery(freshTab); await switcher(freshTab);
    assert.equal(await freshTab.getByRole('link', { name: 'Return to linked library', exact: true }).count(), 0, 'An ordinary new tab does not inherit the unverified session hint');
    assert.equal(await freshTab.getByRole('link', { name: 'Return to starting library', exact: true }).count(), 0);

    const reopened = await browser.newContext({ storageState: await hinted.storageState(), reducedMotion: 'reduce' });
    try {
      const reopenedPage = await reopened.newPage();
      reopenedPage.on('pageerror', error => report.pageErrors.push(error.message));
      await reopenedPage.goto(a.url, { waitUntil: 'domcontentloaded' }); await gallery(reopenedPage); await switcher(reopenedPage);
      assert.equal(await reopenedPage.getByRole('link', { name: 'Return to linked library', exact: true }).count(), 0, 'Reopening a profile without sessionStorage does not preserve the unverified hint');
      assert.equal(await reopenedPage.getByRole('link', { name: 'Return to starting library', exact: true }).count(), 0);
    } finally { await reopened.close(); }

    await hintedPage.getByRole('button', { name: 'Remember this return address', exact: true }).click();
    const remembered = await hintedPage.evaluate(() => JSON.parse(localStorage.getItem('stream-node-home')));
    assert.equal(remembered.url, linkedOrigin); assert.equal(remembered.confirmed, true);
    await hintedPage.getByRole('link', { name: 'Return to starting library', exact: true }).waitFor();
    await freshTab.reload({ waitUntil: 'domcontentloaded' }); await gallery(freshTab); await switcher(freshTab);
    const confirmedReturn = freshTab.getByRole('link', { name: 'Return to starting library', exact: true });
    await confirmedReturn.waitFor();
    assert.equal(new URL(await confirmedReturn.getAttribute('href')).origin, linkedOrigin, 'Only an explicitly remembered return address persists to a fresh tab');
    assert.equal(externalRequests, 0, 'Return hints and bookmarks do not automatically contact their destination');
    report.checks.push('forged return fragments remain neutral session-only hints', 'only explicit remember persists a confirmed starting-library bookmark');
  } finally { await hinted.close(); }
  assert.deepEqual(report.pageErrors, []);
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  await Promise.allSettled(servers.map(server => server.stop()));
  fs.rmSync(fixture, { recursive: true, force: true });
});
