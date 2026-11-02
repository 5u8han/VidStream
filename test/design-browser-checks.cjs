'use strict';

const assert = require('node:assert/strict');

// Called by browser-regression.cjs after its temporary library is ready.
// Each browser profile below belongs only to that generated test server.
async function checkDesignEntrance({ browser, baseURL, report }) {
  const contexts = [];
  async function profile(options = {}) {
    const context = await browser.newContext({
      baseURL, viewport: { width: 1280, height: 800 },
      reducedMotion: 'no-preference', ...options,
    });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__designEntrances = [];
      document.addEventListener('animationstart', event => {
        if (!event.animationName.startsWith('entrance-')) return;
        const style = getComputedStyle(event.target);
        function milliseconds(value) {
          return parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
        }
        window.__designEntrances.push({
          name: event.animationName,
          classes: event.target.className,
          item: event.target.dataset.itemId || null,
          durationMs: milliseconds(style.animationDuration),
          delayMs: milliseconds(style.animationDelay),
        });
      }, true);
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    return { context, page };
  }
  async function login(page) {
    await page.getByLabel('Username', { exact: true }).fill('qa');
    await page.getByLabel('Password', { exact: true }).fill('browser-regression-passphrase');
    // Successful sign-in reloads the current URL. Wait for that document,
    // rather than accepting a matching control left in the previous document.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await gallery(page);
  }
  async function gallery(page) {
    await page.locator('#grid .tile').first().waitFor();
    await page.waitForFunction(() => window.StreamEntrance.state.needsGallery() === false);
  }
  async function frames(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function finishes(page) {
    await page.waitForFunction(() => !document.querySelector('.entrance-card,.entrance-shell,.entrance-tile,.entrance-welcome-reveal'));
  }
  async function events(page, name) {
    return page.evaluate(name => window.__designEntrances.filter(entry => !name || entry.name === name), name);
  }
  async function assertGalleryEntrance(page) {
    await page.locator('.entrance-welcome').waitFor();
    await page.waitForFunction(() => window.__designEntrances.some(entry => entry.name === 'entrance-tile'));
    const tileEvents = await events(page, 'entrance-tile');
    assert.ok(tileEvents.length > 0 && tileEvents.length <= 18, 'Only a bounded visible tile batch enters');
    assert.equal(new Set(tileEvents.map(entry => entry.item)).size, tileEvents.length, 'Each participating tile enters once');
    for (const event of tileEvents) {
      assert.ok(event.delayMs >= 0 && event.delayMs <= 240, 'Stagger stays within 240 ms');
      assert.ok(event.durationMs + event.delayMs <= 600, 'All tile entrances finish within 600 ms');
    }
    await finishes(page);
  }
  async function authenticatedProfile(options) {
    const result = await profile(options);
    const response = await result.context.request.post('/api/login', {
      data: { username: 'qa', password: 'browser-regression-passphrase' },
    });
    assert.ok(response.ok(), 'Generated fixture login succeeds');
    return result;
  }

  try {
    let { context, page } = await profile();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__designEntrances.some(entry => entry.name === 'entrance-card'));
    assert.equal(await page.evaluate(() => window.StreamEntrance.state.needsWelcome()), false);
    assert.equal(await page.evaluate(() => window.StreamEntrance.state.needsGallery()), true);
    await finishes(page);

    // Refreshing the sign-in screen is not a new visit or successful login.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).waitFor();
    await frames(page);
    assert.deepEqual(await events(page, 'entrance-card'), []);
    await page.getByLabel('Username', { exact: true }).fill('qa');
    await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/login' && response.status() === 401),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.signin-card button[type="submit"]').disabled);
    assert.equal(await page.evaluate(() => window.StreamEntrance.state.needsWelcome()), false, 'Rejected credentials do not rearm welcome');
    await login(page);
    await assertGalleryEntrance(page);
    assert.equal(await page.locator('.modal-scrim .signin-card').evaluate(card => card.parentElement.inert), true, 'Closed sign-in form cannot receive keyboard focus');
    report.checks.push('first browser sign-in entrance', 'success-only welcome/gallery reset', 'bounded tile entrances with cleanup');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await gallery(page);
    await frames(page);
    assert.equal(await page.locator('.entrance-welcome').count(), 0);
    assert.deepEqual(await events(page, 'entrance-tile'), [], 'Reload does not replay the gallery entrance');

    // A new context with persisted cookies/localStorage models closing and
    // reopening an already authenticated browser profile.
    const savedProfile = await context.storageState();
    await context.close();
    ({ context, page } = await profile({ storageState: savedProfile }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await gallery(page);
    await frames(page);
    assert.equal(await page.locator('.entrance-welcome').count(), 0);
    assert.deepEqual(await events(page, 'entrance-tile'), []);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/items');
    await page.getByRole('combobox', { name: 'Filter by type', exact: true }).selectOption('photo');
    await response;
    await page.waitForFunction(() => document.querySelectorAll('#grid .tile').length > 0 && !document.querySelector('#grid .video-tile'));
    await frames(page);
    assert.deepEqual(await events(page, 'entrance-tile'), [], 'Changing a filter does not replay entrance effects');
    report.checks.push('authenticated refresh/reopen stays quiet', 'filter changes do not replay tile entrances');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.locator('.links-bottom').getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);
    await page.getByLabel('Username', { exact: true }).waitFor();
    await frames(page);
    assert.deepEqual(await events(page, 'entrance-card'), [], 'Logout alone does not count as a fresh successful login');
    await login(page);
    await assertGalleryEntrance(page);
    report.checks.push('logout followed by successful login replays welcome');

    for (const mode of ['reduced-motion', 'effects-off']) {
      const quiet = await authenticatedProfile(mode === 'reduced-motion' ? { reducedMotion: 'reduce' } : {});
      if (mode === 'effects-off') await quiet.context.addInitScript(() => localStorage.setItem('stream-effects', 'off'));
      await quiet.page.goto('/', { waitUntil: 'domcontentloaded' });
      await gallery(quiet.page);
      await frames(quiet.page);
      assert.equal(await quiet.page.locator('.entrance-tile,.entrance-card,.entrance-shell,.entrance-welcome-reveal').count(), 0, mode + ' avoids decorative animation classes');
      assert.deepEqual(await events(quiet.page), [], mode + ' does not start entrance animations');
      assert.equal(await quiet.page.evaluate(() => window.StreamEntrance.state.needsWelcome()), false);
      assert.equal(await quiet.page.evaluate(() => window.StreamEntrance.state.needsGallery()), false);
      await quiet.page.locator('.video-tile').first().click();
      await quiet.page.waitForFunction(() => document.querySelector('.lightbox.open video')?.readyState >= 1);
      await quiet.context.close();
    }
    report.checks.push('reduced-motion/effects-off skip entrances and keep playback usable');

    const changingPreference = await authenticatedProfile();
    await changingPreference.page.goto('/', { waitUntil: 'domcontentloaded' });
    await gallery(changingPreference.page);
    await changingPreference.page.locator('.entrance-tile').first().waitFor();
    await changingPreference.page.emulateMedia({ reducedMotion: 'reduce' });
    await changingPreference.page.waitForFunction(() => !document.querySelector('.entrance-tile,.entrance-shell,.entrance-welcome-reveal'));
    await changingPreference.page.emulateMedia({ reducedMotion: 'no-preference' });
    await frames(changingPreference.page);
    assert.equal(await changingPreference.page.locator('.entrance-tile,.entrance-shell,.entrance-welcome-reveal').count(), 0, 'Changing motion preference cancels current work without rearming it');
    await changingPreference.context.close();
    report.checks.push('live reduced-motion change cancels running entrances');

    const shortScreen = await profile({ viewport: { width: 640, height: 360 }, reducedMotion: 'reduce' });
    async function reachableSignInFields(page, names, submitName) {
      const card = page.locator('.modal-scrim.locked .signin-card');
      await card.waitFor();
      const viewportHeight = page.viewportSize().height;
      const bounds = await card.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewportHeight + 1, 'Sign-in card fits a short landscape screen');
      const controls = names.map(name => page.getByLabel(name, { exact: true }));
      controls.push(page.getByRole('button', { name: submitName, exact: true }));
      for (const control of controls) {
        await control.focus();
        await control.scrollIntoViewIfNeeded();
        const field = await control.boundingBox();
        const currentCard = await card.boundingBox();
        assert.ok(field.y >= currentCard.y - 1 && field.y + field.height <= currentCard.y + currentCard.height + 1, 'Focused sign-in control scrolls into its card');
        assert.ok(field.y >= 0 && field.y + field.height <= viewportHeight + 1, 'Focused sign-in control stays reachable in the viewport');
      }
    }
    await shortScreen.page.goto('/', { waitUntil: 'domcontentloaded' });
    await reachableSignInFields(shortScreen.page, ['Username', 'Password'], 'Sign in');
    // Change only the test page's presentation config. No owner setup request
    // is submitted, and the temporary server's authentication remains intact.
    await shortScreen.context.route(baseURL + '/', async route => {
      const response = await route.fetch();
      const html = await response.text();
      assert.ok(html.includes('"setupRequired":false'), 'Fixture is already configured');
      await route.fulfill({ response, body: html.replace('"setupRequired":false', '"setupRequired":true') });
    });
    await shortScreen.page.reload({ waitUntil: 'domcontentloaded' });
    await reachableSignInFields(shortScreen.page, ['Username', 'Owner setup code', 'Password'], 'Create owner & lock library');
    await shortScreen.context.close();
    report.checks.push('short landscape sign-in/owner-setup fields and submit remain reachable');

    const retry = await authenticatedProfile();
    let releaseRequest;
    const heldRequest = new Promise(resolve => { releaseRequest = resolve; });
    let firstRequest = true;
    await retry.context.route('**/api/items?*', async route => {
      if (!firstRequest) return route.continue();
      firstRequest = false;
      await heldRequest;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary fixture failure' }) });
    });
    try {
      await retry.page.goto('/', { waitUntil: 'domcontentloaded' });
      await retry.page.locator('.grid-status.entrance-loading .entrance-loading-mark').waitFor();
      assert.equal(await retry.page.evaluate(() => window.StreamEntrance.state.needsGallery()), true);
      releaseRequest();
      await retry.page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assert.equal(await retry.page.evaluate(() => window.StreamEntrance.state.needsGallery()), true, 'A failed first request preserves the media entrance');
      await retry.page.getByRole('button', { name: 'Try again', exact: true }).click();
      await gallery(retry.page);
      await assertGalleryEntrance(retry.page);
    } finally {
      releaseRequest();
    }
    report.checks.push('real loading indicator and first-load retry retain gallery entrance');
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
}

module.exports = { checkDesignEntrance };
