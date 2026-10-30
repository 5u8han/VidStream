'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(initialState = null) {
  const location = { pathname: '/', search: '', hash: '' }, entries = [{ state: initialState, url: '/' }];
  let index = 0, listener, queued = null, routes = 0;
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url }); index++; setURL(url); },
    replaceState(state, _title, url) { entries[index] = { state, url }; setURL(url); },
    back() { this.go(-1); },
    go(delta) { const target = index + delta; if (target >= 0 && target < entries.length) queued = target; },
  };
  function setURL(url) { const value = new URL(url, 'http://example.test'); Object.assign(location, { pathname: value.pathname, search: value.search, hash: value.hash }); }
  const window = { addEventListener: (name, fn) => { assert.equal(name, 'popstate'); listener = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/navigation.js'), 'utf8'), { window, location, history, Date });
  function flush() {
    assert.notEqual(queued, null, 'Expected a browser traversal'); index = queued; queued = null; setURL(entries[index].url);
    const event = { state: history.state, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
    listener(event); if (!event.stopped) routes++; return event;
  }
  const events = [];
  function layer(id, forwardResult) { return { back() { events.push('back:' + id); }, forward() { events.push('forward:' + id); return forwardResult; } }; }
  return { navigation: window.StreamNavigation, history, flush, events, layer, get routes() { return routes; }, get index() { return index; }, get location() { return location.pathname; } };
}

test('browser Back and Forward preserve common parents across three UI levels', () => {
  const f = fixture(), n = f.navigation;
  n.enter('settings', f.layer('root')); n.enter('section', f.layer('section')); n.enter('detail', f.layer('detail'));
  f.history.back(); assert.equal(f.flush().stopped, true); assert.equal(n.depth(), 2);
  f.history.go(1); f.flush(); assert.equal(n.depth(), 3);
  assert.deepEqual(f.events, ['back:detail', 'forward:detail']);
  f.history.go(-2); f.flush(); assert.equal(n.depth(), 1);
  f.history.go(1); f.flush(); assert.equal(n.depth(), 2);
  assert.deepEqual(f.events, ['back:detail', 'forward:detail', 'back:detail', 'back:section', 'forward:section']);
  assert.equal(f.routes, 0);
});

test('leave root removes descendants before callbacks and ignores repeated pending Back', () => {
  const f = fixture(), n = f.navigation, depths = [];
  ['settings', 'section', 'detail'].forEach(id => n.enter(id, { back() { depths.push(n.depth()); }, forward() {} }));
  assert.equal(n.leave('settings'), true); assert.equal(n.back(), false); assert.equal(n.enter('other', f.layer('other')), false);
  f.flush(); assert.equal(n.depth(), 0); assert.equal(n.has('settings'), false);
  assert.deepEqual(depths, [0, 0, 0]); assert.equal(f.index, 0);
  f.history.go(1); f.flush(); assert.equal(n.depth(), 1);
});

test('real route URL changes pass through while same-URL UI pops are contained', () => {
  const f = fixture(), n = f.navigation;
  n.enter('settings', f.layer('root'));
  f.history.pushState({ streamItem: 'clip' }, '', '/clip');
  f.history.back(); assert.equal(f.flush().stopped, false); assert.equal(f.location, '/');
  assert.equal(f.routes, 1);
  n.enter('section', f.layer('section')); n.back(); assert.equal(f.flush().stopped, true);
  assert.equal(f.routes, 1);
});

test('stale markers and discarded UI renderers never trap browser Back or prevent reopening', () => {
  const stale = fixture({ streamUI: 'from-before-reload' });
  stale.history.pushState({}, '', '/clip'); stale.history.back();
  assert.equal(stale.flush().stopped, false); assert.equal(stale.navigation.depth(), 0);
  const f = fixture(), n = f.navigation;
  n.enter('settings', f.layer('discarded', false)); n.back(); f.flush();
  f.history.go(1); f.flush(); assert.equal(n.has('settings'), false);
  assert.equal(n.enter('settings', f.layer('new')), true); assert.equal(n.depth(), 1);
});
