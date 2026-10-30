'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fit } = require('../public/viewer-layout');

function check(width, height, viewportWidth, viewportHeight, chromeHeight = 86) {
  const result = fit({ width, height, viewportWidth, viewportHeight, chromeHeight });
  assert.ok(result.width <= viewportWidth - 24);
  assert.ok(result.height <= viewportHeight - 24);
  assert.ok(result.mediaWidth <= width && result.mediaHeight <= height);
  assert.ok(result.mediaWidth <= result.width);
  assert.ok(result.mediaHeight + chromeHeight <= result.height + 1);
  assert.ok(Math.abs(result.mediaWidth / result.mediaHeight - width / height) < .02);
  return result;
}

test('portrait and landscape viewer cards follow their media instead of a fixed viewport box', () => {
  const portrait = check(1080, 1920, 1920, 1080);
  const landscape = check(3840, 2160, 1920, 1080);
  assert.ok(portrait.width < 450);
  assert.ok(landscape.width > 1000);
  assert.equal(portrait.height, landscape.height);
  const square = check(1600, 1600, 1920, 1080);
  assert.equal(square.mediaWidth, square.mediaHeight);
});

test('small sources stay native size and ultra-wide media does not gain vertical letterbox space', () => {
  const tiny = check(320, 180, 1920, 1080);
  assert.equal(tiny.mediaWidth, 320);
  assert.equal(tiny.mediaHeight, 180);
  assert.equal(tiny.height, 266);
  const wide = check(3840, 800, 1920, 1080);
  assert.ok(wide.height < 450);
});

test('mobile and short landscape screens budget toolbar and wrapped stats before sizing media', () => {
  check(1080, 1920, 390, 844, 170);
  const without = check(1920, 1080, 844, 390, 86);
  const withStats = check(1920, 1080, 844, 390, 156);
  assert.ok(withStats.mediaHeight < without.mediaHeight);
  assert.ok(withStats.height <= 390 * .8);
});

test('unknown dimensions use a bounded landscape placeholder', () => {
  const result = fit({ viewportWidth: 1280, viewportHeight: 720, chromeHeight: 86 });
  assert.equal(result.mediaWidth, 640);
  assert.equal(result.mediaHeight, 360);
});
