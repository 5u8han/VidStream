(function () {
  'use strict';
  function install(grid, options) {
    var mode = options.mode || 'off',
      active = null,
      groups = new Map(),
      membership = new WeakMap(),
      frame = null;
    function removeTile(tile) {
      var creator = membership.get(tile);
      if (creator === undefined) return;
      var tiles = groups.get(creator);
      if (tiles) {
        tiles.delete(tile);
        if (!tiles.size) groups.delete(creator);
      }
      membership.delete(tile);
      tile.classList.remove('artist-active');
    }
    function updateTile(tile) {
      if (!tile.matches?.('.tile')) return;
      if (!tile.isConnected || !tile.hasAttribute('data-hydrated')) {
        removeTile(tile);
        return;
      }
      var creator = tile._item.creator || '(Unsorted)';
      if (membership.get(tile) !== creator) {
        removeTile(tile);
        if (!groups.has(creator)) groups.set(creator, new Set());
        groups.get(creator).add(tile);
        membership.set(tile, creator);
      }
      tile.classList.toggle('artist-active', creator === active);
    }
    function paintGroup(creator, selected) {
      var tiles = groups.get(creator);
      if (tiles)
        tiles.forEach(function (tile) {
          tile.classList.toggle('artist-active', selected);
        });
    }
    function select(creator) {
      if (creator === active) return;
      paintGroup(active, false);
      active = creator;
      paintGroup(active, true);
      grid.classList.toggle('artist-has-active', active !== null);
    }
    function refreshNow() {
      frame = null;
      groups.forEach(function (tiles, creator) {
        tiles.forEach(function (tile) { tile.classList.toggle('artist-active', creator === active); });
      });
      grid.dataset.artistOutlines = mode;
    }
    function refresh() {
      if (frame === null) frame = requestAnimationFrame(refreshNow);
    }
    function hover(event) {
      if (mode === 'off') return;
      var tile = event.target.closest?.('.tile');
      select(tile && grid.contains(tile) ? tile._item.creator || '(Unsorted)' : null);
    }
    grid.addEventListener('pointerover', hover);
    grid.addEventListener('focusin', hover);
    grid.addEventListener('pointerleave', function () {
      select(null);
    });
    grid.addEventListener('focusout', function (event) {
      if (!grid.contains(event.relatedTarget)) select(null);
    });
    // Track only mounted tile contents. Appending a catalog page or hovering
    // an artist must not rescan or rewrite every previously loaded tile.
    new MutationObserver(function (records) {
      records.forEach(function (record) { updateTile(record.target); });
    }).observe(grid, { attributes: true, subtree: true, attributeFilter: ['data-hydrated'] });
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.removedNodes.forEach(function (node) { if (node.nodeType === 1) removeTile(node); });
        record.addedNodes.forEach(function (node) { if (node.nodeType === 1) updateTile(node); });
      });
    }).observe(grid, { childList: true });
    grid.querySelectorAll('.tile[data-hydrated]').forEach(updateTile);
    grid.dataset.artistOutlines = mode;
    return {
      refresh: refresh,
      setMode: function (value) {
        mode = value;
        if (mode === 'off') select(null);
        grid.dataset.artistOutlines = mode;
      },
      getMode: function () {
        return mode;
      }
    };
  }
  window.StreamArtistOutlines = { install: install };
})();
