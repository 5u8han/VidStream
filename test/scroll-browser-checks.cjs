'use strict';
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

// Reuse the generated fixture's media through a synthetic, paginated catalog.
// This measures long-scroll resource retention without importing user files or
// making hundreds of duplicate preview encodes just to exercise the browser.
async function checkLongScroll({ page, context, report }) {
  const response = await context.request.get('/api/items?limit=120');
  assert.ok(response.ok());
  const catalog = await response.json();
  const photo = catalog.items.find(item => item.type === 'photo');
  const video = catalog.items.find(item => item.type === 'video');
  assert.ok(photo && video, 'The generated library supplies both fixture types');
  const total = 960;
  const items = Array.from({ length: total }, (_, index) => ({
    ...(index % 4 ? photo : video), id: 'scroll-fixture-' + index,
    filename: 'scroll-fixture-' + index + '.jpg', creator: 'Scroll fixture',
    album: 'Scroll fixture', width: 240, height: 180
  }));
  async function intercept(route) {
    const url = new URL(route.request().url());
    const start = Number(url.searchParams.get('cursor')) || 0;
    const end = Math.min(total, start + 60);
    await route.fulfill({ json: {
      ...catalog, items: items.slice(start, end), total,
      nextCursor: end < total ? String(end) : null,
      albums: ['Scroll fixture'], creators: ['Scroll fixture']
    } });
  }
  await page.route('**/api/items?**', intercept);
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.tile[data-hydrated] img.loaded').first().waitFor();
    const firstBox = await page.locator('.tile').first().boundingBox();
    let peakImages = 0, peakHydrated = 0, peakVideos = 0;
    for (let batch = 0; batch < total / 60; batch++) {
      await page.waitForFunction(minimum => document.querySelectorAll('.tile').length >= minimum, (batch + 1) * 60);
      const counts = await page.evaluate(() => ({
        images: document.querySelectorAll('#grid img[src]').length,
        hydrated: document.querySelectorAll('#grid .tile[data-hydrated]').length,
        videos: document.querySelectorAll('#grid video[src]').length
      }));
      peakImages = Math.max(peakImages, counts.images);
      peakHydrated = Math.max(peakHydrated, counts.hydrated);
      peakVideos = Math.max(peakVideos, counts.videos);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await delay(60);
    }
    await page.waitForFunction(() => !document.querySelector('#grid .tile').hasAttribute('data-hydrated'));
    const deep = await page.evaluate(() => ({
      shells: document.querySelectorAll('#grid .tile').length,
      hydrated: document.querySelectorAll('#grid .tile[data-hydrated]').length,
      images: document.querySelectorAll('#grid img[src]').length,
      firstChildren: document.querySelector('#grid .tile').childElementCount
    }));
    assert.equal(deep.shells, total, 'Every loaded item remains reachable in the layout');
    assert.equal(deep.firstChildren, 0, 'Far-away tiles release their media and control subtree');
    assert.ok(peakHydrated < 180 && deep.hydrated < 180, 'Nearby DOM stays bounded: ' + JSON.stringify({ peakHydrated, deep }));
    assert.ok(peakImages < 180 && deep.images < 180, 'Image sources do not accumulate across the catalog');
    assert.ok(peakVideos <= 24, 'Only the configured preview budget and brief release grace can retain sources');
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('.tile').first().locator('img.loaded').waitFor();
    const returnedBox = await page.locator('.tile').first().boundingBox();
    assert.equal(returnedBox.x, firstBox.x);
    assert.equal(returnedBox.y, firstBox.y);
    assert.equal(returnedBox.width, firstBox.width);
    assert.equal(returnedBox.height, firstBox.height);
    assert.equal(await page.locator('.tile').first().getAttribute('data-item-id'), 'scroll-fixture-0');
    await page.locator('.tile').first().hover();
    await page.waitForFunction(() => document.querySelector('#grid').dataset.artistOutlines === 'off' || document.querySelectorAll('#grid .artist-active').length > 0);
    const activeOutlineCount = await page.locator('#grid .artist-active').count();
    assert.ok(activeOutlineCount < 180, 'Artist hover only updates nearby mounted tiles');
    await page.locator('.tile').first().getByRole('button', { name: 'Resize this video tile' }).click();
    assert.ok(await page.locator('.tile').first().evaluate(tile => tile.classList.contains('tile-expanded')));
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    // Keyboard focus deliberately pins a control's contents until focus
    // leaves it, rather than discarding the active element offscreen.
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForFunction(() => !document.querySelector('#grid .tile').hasAttribute('data-hydrated'));
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('.tile').first().locator('img.loaded').waitFor();
    assert.ok(await page.locator('.tile').first().evaluate(tile => tile.classList.contains('tile-expanded') && tile.dataset.manualScale === '1'), 'Manual sizing survives resource release');
    report.longScroll = { total, peakHydrated, peakImages, peakVideos, activeOutlineCount, deep };
    report.checks.push('960-item scroll bounds nearby media/control DOM', 'scroll back restores thumbnails without shifting layout', 'manual tile size survives unloading');
  } finally {
    await page.unroute('**/api/items?**', intercept);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
}
module.exports = { checkLongScroll };
