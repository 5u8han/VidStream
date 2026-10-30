(function () {
  'use strict';
  var stack = [], serial = 0, pending = false, registry = new Map();
  function url() { return location.pathname + location.search + location.hash; }
  var previousURL = url();
  // Route changes also happen in the gallery/player. Record them without
  // changing the browser history contract, so a real route pop still reaches
  // the app's route handler while UI-only pops are contained here.
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var result = original.apply(this, arguments); previousURL = url(); return result; };
  });
  function enter(id, handlers) {
    if (pending || stack.some(function (entry) { return entry.id === id; })) return false;
    // A new push discards browser Forward history. Release its old renderers
    // too, rather than retaining every settings dialog opened this session.
    var active = new Set(stack.map(function (entry) { return entry.token; }));
    registry.forEach(function (_, token) { if (!active.has(token)) registry.delete(token); });
    var entry = { id: id, token: Date.now() + '-' + (++serial), handlers: handlers, parent: stack.length ? stack[stack.length - 1].token : null, base: url() };
    history.pushState(Object.assign({}, history.state, { streamUI: entry.token }), '', url());
    stack.push(entry); registry.set(entry.token, entry);
    return true;
  }
  function back() { if (!stack.length || pending) return false; pending = true; history.back(); return true; }
  function leave(id) {
    var index = stack.findIndex(function (entry) { return entry.id === id; });
    if (index < 0 || pending) return false;
    pending = true; history.go(index - stack.length); return true;
  }
  window.addEventListener('popstate', function (event) {
    pending = false;
    var sameURL = previousURL === url(); previousURL = url();
    var token = event.state && event.state.streamUI;
    var target = token && registry.get(token), path = [], next = target;
    if (target && target.base === url()) {
      while (next) { path.unshift(next); next = next.parent ? registry.get(next.parent) : null; }
    }
    // Resolve the complete target lineage before touching the current stack.
    // A forward target is often absent from stack but shares its root; popping
    // first would close that root and lose the forward restoration path.
    var common = 0;
    while (common < stack.length && common < path.length && stack[common].token === path[common].token) common++;
    var removed = stack.splice(common).reverse();
    removed.forEach(function (entry) { entry.handlers.back(); });
    for (var i = common; i < path.length; i++) {
      var entry = path[i];
      if (typeof entry.handlers.forward !== 'function') break;
      stack.push(entry);
      // A renderer may decline restoration after its DOM was discarded.
      if (entry.handlers.forward() === false) { stack.pop(); break; }
    }
    // Unknown markers after a reload are deliberately harmless: nothing is
    // restored and the normal route handler remains free to process the pop.
    if (sameURL && (removed.length || target && target.base === url())) event.stopImmediatePropagation();
  }, true);
  window.StreamNavigation = { enter: enter, back: back, leave: leave,
    has: function (id) { return stack.some(function (entry) { return entry.id === id; }); },
    depth: function () { return stack.length; } };
})();
