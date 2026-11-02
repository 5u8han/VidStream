'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createState } = require('../public/entrance');

function browserStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('a new browser has separate welcome and gallery entrances', () => {
  const storage = browserStorage();
  const landing = createState(storage);
  assert.equal(landing.needsWelcome(), true);
  assert.equal(landing.needsGallery(), true);

  // Showing a locked sign-in card must not spend the first media entrance.
  landing.welcomeSeen();
  assert.equal(landing.needsWelcome(), false);
  assert.equal(landing.needsGallery(), true);

  const afterReload = createState(storage);
  assert.equal(afterReload.needsWelcome(), false);
  assert.equal(afterReload.needsGallery(), true);
  afterReload.gallerySeen();
  assert.equal(afterReload.needsGallery(), false);
});

test('reopening an authenticated browser keeps already seen entrances consumed', () => {
  const storage = browserStorage();
  const firstPage = createState(storage, { authenticated: true });
  firstPage.welcomeSeen();
  firstPage.gallerySeen();

  // A fresh state models reopening the browser with the same saved profile.
  const reopened = createState(storage, { authenticated: true });
  assert.equal(reopened.needsWelcome(), false);
  assert.equal(reopened.needsGallery(), false);
});

test('only confirmed sign-in rearms both entrances and survives the reload', () => {
  const storage = browserStorage();
  const original = createState(storage, { authenticated: true });
  original.welcomeSeen();
  original.gallerySeen();

  // A signed-out visit or rejected credentials do not call signedIn().
  const signInPage = createState(storage, { authenticated: false });
  assert.equal(signInPage.needsWelcome(), false);
  assert.equal(signInPage.needsGallery(), false);
  assert.equal(createState(storage).needsGallery(), false);

  signInPage.signedIn();
  assert.equal(signInPage.needsWelcome(), true);
  assert.equal(signInPage.needsGallery(), true);
  const successfulLogin = createState(storage, { authenticated: true });
  assert.equal(successfulLogin.needsWelcome(), true);
  assert.equal(successfulLogin.needsGallery(), true);
  successfulLogin.welcomeSeen();
  successfulLogin.gallerySeen();

  // The next successful logout/login cycle gets a new entrance too.
  const nextLogin = createState(storage);
  nextLogin.signedIn();
  assert.equal(createState(storage).needsWelcome(), true);
  assert.equal(createState(storage).needsGallery(), true);
});

test('failed or empty requests leave the first media entrance pending', () => {
  const storage = browserStorage();
  const state = createState(storage);
  state.welcomeSeen();
  // Data fetches, empty libraries and filter changes have no state side effect.
  for (let i = 0; i < 5; i++) assert.equal(state.needsGallery(), true);
  assert.equal(createState(storage).needsGallery(), true);

  // A committed nonempty batch consumes it once, including later pagination.
  state.gallerySeen();
  state.gallerySeen();
  assert.equal(state.needsGallery(), false);
  assert.equal(createState(storage).needsGallery(), false);
});

test('separate browser profiles each get their own first experience', () => {
  const first = createState(browserStorage());
  first.welcomeSeen();
  first.gallerySeen();
  const otherDevice = createState(browserStorage());
  assert.equal(otherDevice.needsWelcome(), true);
  assert.equal(otherDevice.needsGallery(), true);
});

test('open pages observe consumed and rearmed entrances through shared storage', () => {
  const storage = browserStorage();
  const pageA = createState(storage);
  const pageB = createState(storage);
  pageA.welcomeSeen();
  pageA.gallerySeen();
  assert.equal(pageB.needsWelcome(), false);
  assert.equal(pageB.needsGallery(), false);
  pageB.signedIn();
  assert.equal(pageA.needsWelcome(), true);
  assert.equal(pageA.needsGallery(), true);
});

test('unavailable storage degrades to usable once-per-page state', () => {
  for (const storage of [null, undefined, {
    getItem() { throw new Error('Storage blocked'); },
    setItem() { throw new Error('Storage blocked'); },
    removeItem() { throw new Error('Storage blocked'); },
  }]) {
    const state = createState(storage);
    assert.equal(state.needsWelcome(), true);
    assert.equal(state.needsGallery(), true);
    assert.doesNotThrow(() => { state.welcomeSeen(); state.gallerySeen(); });
    assert.equal(state.needsWelcome(), false);
    assert.equal(state.needsGallery(), false);
    assert.doesNotThrow(() => state.signedIn());
    assert.equal(state.needsWelcome(), true);
    assert.equal(state.needsGallery(), true);
  }
});

test('a write failure still consumes the entrance for the current page', () => {
  const storage = {
    getItem() { return null; },
    setItem() { throw new Error('Storage quota exceeded'); },
    removeItem() { throw new Error('Storage quota exceeded'); },
  };
  const state = createState(storage);
  state.welcomeSeen();
  state.gallerySeen();
  assert.equal(state.needsWelcome(), false);
  assert.equal(state.needsGallery(), false);
});
