(function () {
  'use strict';
  function install(grid, options) {
    var mode = options.mode || 'off',
      active = null,
      groups = new Map(),
      frame = null;
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
      groups.clear();
      grid.querySelectorAll('.tile').forEach(function (tile) {
        var creator = tile._item.creator || '(Unsorted)';
        if (!groups.has(creator)) groups.set(creator, new Set());
        groups.get(creator).add(tile);
        tile.classList.toggle('artist-active', creator === active);
      });
      grid.dataset.artistOutlines = mode;
    }
    function refresh() {
      if (frame === null) frame = requestAnimationFrame(refreshNow);
    }
    function hover(event) {
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
    new MutationObserver(function (records) {
      if (
        records.some(function (record) {
          return Array.from(record.addedNodes)
            .concat(Array.from(record.removedNodes))
            .some(function (node) {
              return node.nodeType === 1 && node.matches?.('.tile,.sentinel');
            });
        })
      )
        refresh();
    }).observe(grid, { childList: true });
    grid.dataset.artistOutlines = mode;
    return {
      refresh: refresh,
      setMode: function (value) {
        mode = value;
        grid.dataset.artistOutlines = mode;
      },
      getMode: function () {
        return mode;
      }
    };
  }
  window.StreamArtistOutlines = { install: install };
})();
