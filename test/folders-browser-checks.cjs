'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// This helper uses only browser-regression.cjs's generated temporary library.
// It restores navigation, access settings and fixture media before returning.
async function checkFolderCollections({ browser, baseURL, report, media }) {
  const contexts = [];
  const directory = path.join(media, 'Artist-0', 'Folder-browser-fixture');
  const deep = path.join(directory, 'Season');
  const screenshots = process.env.STREAM_BROWSER_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-folder-preview-'));
  fs.mkdirSync(screenshots, { recursive: true });
  let owner, originalFolders, originalSettings, sharedItem;
  async function json(context, url, body) {
    const response = body === undefined ? await context.request.get(url) : await context.request.post(url, { data: body });
    const data = await response.json();
    assert.ok(response.ok(), response.status() + ': ' + JSON.stringify(data));
    return data;
  }
  async function profile(options = {}, cookies) {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', ...options });
    contexts.push(context);
    if (cookies) await context.addCookies(cookies);
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    return { context, page };
  }
  async function depth(page, value) { await page.waitForFunction(value => window.StreamNavigation.depth() === value, value); }
  async function idle(page, count) {
    await page.waitForFunction(count => document.querySelector('#grid')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('#grid .tile').length === count, count);
  }
  async function dismissWelcome(page) {
    const welcome = page.getByRole('button', { name: 'Dismiss welcome', exact: true });
    if (await welcome.count()) await welcome.click();
  }
  async function capture(page, name) {
    const filename = path.join(screenshots, name + '.png');
    await page.screenshot({ path: filename }); report.screenshots.push(filename);
  }
  async function openFolders(page) {
    await page.locator('.folder-trigger').click(); await depth(page, 1);
    await page.locator('#folder-menu').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#folder-menu .folder-option').first().evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }), 'The dropdown options are painted and clickable beyond the header title');
  }
  async function choose(page, name) {
    await openFolders(page);
    await page.locator('#folder-menu').getByRole('button', { name, exact: true }).click();
    await depth(page, 0);
  }
  async function manage(page) {
    await openFolders(page);
    await page.getByRole('button', { name: 'Choose folders…', exact: true }).click();
    await page.locator('#settings-folders[open]').waitFor();
    await page.getByRole('button', { name: 'Add folder', exact: true }).waitFor();
    await depth(page, 2);
  }
  async function closeSettings(page) {
    await page.keyboard.press('Escape'); await depth(page, 1);
    await page.keyboard.press('Escape'); await depth(page, 0);
  }
  async function assertFits(page, selector, vertical = true) {
    const bounds = await page.locator(selector).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.ok(bounds.x >= -1 && bounds.right <= bounds.width + 1 && (!vertical || bounds.y >= -1 && bounds.bottom <= bounds.height + 1), selector + ' fits: ' + JSON.stringify(bounds));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, selector + ' does not create horizontal page overflow');
  }

  try {
    const desktop = await profile(); owner = desktop.context;
    await json(owner, '/api/login', { username: 'qa', password: 'browser-regression-passphrase' });
    originalFolders = (await json(owner, '/api/folders')).folders;
    originalSettings = await json(owner, '/api/settings');
    const originalItems = (await json(owner, '/api/items?limit=120')).items.map(item => item.id).sort();
    fs.mkdirSync(deep, { recursive: true });
    fs.copyFileSync(path.join(media, 'sample.mp4'), path.join(deep, 'folder-probe-video.mp4'));
    fs.copyFileSync(path.join(media, 'Artist-0', 'photo-0.jpg'), path.join(deep, 'folder-probe-still.jpg'));
    await json(owner, '/api/rescan', {});

    const page = desktop.page;
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#grid .tile').first().waitFor(); await dismissWelcome(page);
    await manage(page);
    for (const [name, folder] of [['Deep collection', 'Artist-0/Folder-browser-fixture'], ['Hidden private collection', 'Artist-1'], ['Shared collection', 'Artist-2']]) {
      await page.getByRole('button', { name: 'Add folder', exact: true }).click();
      const row = page.locator('.folder-edit-row').last();
      await row.getByLabel('Folder menu name', { exact: true }).fill(name);
      await row.getByLabel('Folder path inside media', { exact: true }).fill(folder);
    }
    let releaseSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    async function heldSave(route) {
      if (route.request().method() === 'POST') await saveGate;
      await route.continue();
    }
    await page.route('**/api/folders', heldSave);
    try {
      const saving = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/folders');
      await page.getByRole('button', { name: 'Save folder menu', exact: true }).click();
      await saving;
      assert.equal(await page.locator('#settings-folders input:not([disabled]),#settings-folders button:not([disabled])').count(), 0, 'Pending save freezes row edits, removals and additions');
      releaseSave();
      await page.locator('#settings-folders [role=status]').filter({ hasText: 'Folder menu saved.' }).waitFor();
      assert.equal(await page.locator('.folder-edit-row input:not([disabled])').count(), 6);
    } finally { releaseSave(); await page.unroute('**/api/folders', heldSave); }
    const configured = (await json(owner, '/api/folders')).folders;
    assert.equal(configured.length, 3);
    await page.locator('#settings-folders').scrollIntoViewIfNeeded();
    await capture(page, 'desktop-folder-settings');
    await closeSettings(page);
    assert.equal(await page.getByRole('combobox', { name: 'Filter by album', exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('combobox', { name: 'Filter by creator', exact: true }).isVisible(), false);
    report.checks.push('manual named nested-folder collections replace legacy folder/artist enumerators', 'pending folder saves prevent row mutation races and restore controls afterward');

    await openFolders(page); await capture(page, 'desktop-folder-dropdown');
    await page.keyboard.press('Escape'); await depth(page, 0);
    assert.ok(await page.locator('.folder-trigger').evaluate(button => document.activeElement === button));
    await page.goForward(); await depth(page, 1);
    await page.goBack(); await depth(page, 0);
    await openFolders(page);
    await page.getByRole('button', { name: 'View options', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#folder-menu').hidden);
    await page.locator('.view-panel.open').waitFor(); await depth(page, 1);
    await page.locator('.folder-trigger').click();
    await page.locator('#folder-menu').waitFor({ state: 'visible' }); await depth(page, 1);
    assert.equal(await page.locator('.view-panel.open').count(), 0);
    await page.keyboard.press('Escape'); await depth(page, 0);
    report.checks.push('folder dropdown Escape, focus return, one-click handoff in both directions with View options and browser Back/Forward');

    await choose(page, 'Deep collection'); await idle(page, 2);
    const ids = await page.locator('#grid .tile').evaluateAll(tiles => tiles.map(tile => tile._item.id));
    assert.equal(ids.length, 2);
    assert.ok(await page.locator('#grid .tile').evaluateAll(tiles => tiles.every(tile => tile._item.album === 'Artist-0/Folder-browser-fixture/Season')));
    await page.reload({ waitUntil: 'domcontentloaded' }); await idle(page, 2);
    assert.equal(await page.locator('.folder-trigger-label').textContent(), 'Deep collection');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('searchbox', { name: 'Search photos and videos', exact: true });
    await search.fill('folder-probe-still'); await idle(page, 1);
    assert.equal(await page.locator('#grid .tile').first().evaluate(tile => tile._item.filename), 'folder-probe-still.jpg');
    await search.fill(''); await idle(page, 2);
    const response = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/api/item/'));
    await page.locator('#grid .video-tile').first().click();
    const neighborsResponse = await response, neighbors = await neighborsResponse.json();
    assert.equal(new URL(neighborsResponse.url()).searchParams.get('folder'), configured[0].id);
    assert.equal(neighbors.total, 2);
    const other = neighbors.next || neighbors.prev;
    assert.ok(other && ids.includes(other.id));
    await page.getByRole('button', { name: neighbors.next ? 'Next' : 'Previous', exact: true }).click();
    await page.waitForFunction(filename => document.querySelector('.lightbox-caption')?.textContent === filename, other.filename);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.lightbox.open') && location.pathname === '/');
    report.checks.push('deep-folder selection persists reload and scopes search, player counter and previous/next');

    const marker = crypto.randomUUID(), video = neighbors.item;
    await json(owner, '/api/items/' + video.id + '/preferences', { favorite: true });
    await json(owner, '/api/activity', { events: [{ id: marker, visitor: 'folder-browser-test', itemId: video.id, action: 'open', at: new Date().toISOString(), details: {} }] });
    const beforeRemoval = (await json(owner, '/api/items?limit=120')).items.map(item => item.id).sort();
    await manage(page);
    await page.locator('.folder-edit-row').first().getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Save folder menu', exact: true }).click();
    await page.locator('#settings-folders [role=status]').filter({ hasText: 'Folder menu saved.' }).waitFor();
    await closeSettings(page);
    await page.waitForFunction(() => window.StreamFolders.selected() === '');
    const afterRemoval = (await json(owner, '/api/items?limit=120')).items.map(item => item.id).sort();
    assert.deepEqual(afterRemoval, beforeRemoval);
    for (const id of originalItems) assert.ok(afterRemoval.includes(id));
    const saved = await json(owner, '/api/item/' + video.id);
    assert.equal(saved.item.favorite, true);
    assert.ok((await json(owner, '/api/activity?item=' + video.id)).events.some(event => event.event_key === marker));
    assert.equal(fs.existsSync(path.join(deep, 'folder-probe-video.mp4')), true);
    report.checks.push('removing a selected folder shortcut preserves source files, catalog identities, favorites and viewing history');

    await json(owner, '/api/folders', { folders: configured });
    sharedItem = (await json(owner, '/api/items?folder=' + configured[2].id + '&limit=1')).items[0];
    await json(owner, '/api/items/' + sharedItem.id + '/visibility', { guest: true });
    await json(owner, '/api/settings', { requireLogin: false });
    const guest = await profile();
    const guestFolders = await json(guest.context, '/api/folders');
    assert.deepEqual(guestFolders.folders, [{ id: configured[2].id, name: 'Shared collection' }]);
    await guest.page.goto('/', { waitUntil: 'domcontentloaded' });
    await guest.page.locator('#grid .tile').first().waitFor(); await dismissWelcome(guest.page);
    await openFolders(guest.page);
    assert.equal(await guest.page.locator('#folder-menu').getByRole('button', { name: 'Hidden private collection', exact: true }).count(), 0);
    assert.equal(await guest.page.getByRole('button', { name: 'Choose folders…', exact: true }).count(), 0);
    await guest.page.locator('#folder-menu').getByRole('button', { name: 'Shared collection', exact: true }).click();
    await depth(guest.page, 0); await idle(guest.page, 1);
    const denied = await guest.context.request.get('/api/items?folder=' + configured[1].id);
    assert.equal(denied.status(), 404);
    report.checks.push('guest dropdown omits private collection names and paths and enforces existing media visibility');

    const mobile = await profile({ viewport: { width: 320, height: 844 }, hasTouch: true, isMobile: true }, await owner.cookies());
    await mobile.page.goto('/', { waitUntil: 'domcontentloaded' });
    await mobile.page.locator('#grid .tile').first().waitFor(); await dismissWelcome(mobile.page);
    assert.ok(await mobile.page.locator('.folder-trigger-label').evaluate(label => label.clientWidth > 0 && label.scrollWidth <= label.clientWidth + 1), 'The short library title stays legible beside the node switcher at 320px');
    await openFolders(mobile.page); await assertFits(mobile.page, '#folder-menu');
    assert.equal(await mobile.page.locator('#folder-menu').evaluate(element => getComputedStyle(element).animationName), 'none');
    await capture(mobile.page, 'mobile-320-folder-dropdown');
    await mobile.page.getByRole('button', { name: 'Choose folders…', exact: true }).click();
    await mobile.page.locator('#settings-folders[open]').waitFor(); await depth(mobile.page, 2);
    await assertFits(mobile.page, 'dialog.stream-settings[open]');
    await mobile.page.getByRole('button', { name: 'Save folder menu', exact: true }).scrollIntoViewIfNeeded();
    await assertFits(mobile.page, '.folder-edit-list', false);
    await mobile.page.locator('.folder-edit-row').first().scrollIntoViewIfNeeded();
    await capture(mobile.page, 'mobile-320-folder-settings');
    report.checks.push('320px folder dropdown and editor fit, remain reachable and respect reduced motion');
  } finally {
    if (owner) {
      if (sharedItem) await json(owner, '/api/items/' + sharedItem.id + '/visibility', { guest: sharedItem.guest });
      if (originalFolders) await json(owner, '/api/folders', { folders: originalFolders });
      if (originalSettings) await json(owner, '/api/settings', { requireLogin: originalSettings.security.requireLogin });
    }
    await Promise.allSettled(contexts.map(context => context.close()));
    fs.rmSync(directory, { recursive: true, force: true });
    if (owner) {
      // Owner context has just closed, so use a fresh authenticated API context
      // for the final scan of only this generated test library.
      const cleanup = await browser.newContext({ baseURL });
      try {
        await json(cleanup, '/api/login', { username: 'qa', password: 'browser-regression-passphrase' });
        await json(cleanup, '/api/rescan', {});
      } finally { await cleanup.close(); }
    }
  }
}

module.exports = { checkFolderCollections };
