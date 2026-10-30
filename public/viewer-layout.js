(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamViewerLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function positive(value, fallback) {
    return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  }

  // Media keeps its aspect ratio and is never enlarged beyond its native size.
  // The modest minimum card width is only for the toolbar on tiny/portrait files.
  function fit(options) {
    var vw = positive(options.viewportWidth, 1024), vh = positive(options.viewportHeight, 768);
    var mobile = vw <= 600;
    var maxWidth = Math.max(1, Math.min(vw - 24, vw * (mobile ? .9 : .78)));
    var maxHeight = Math.max(1, Math.min(vh - 24, vh * (mobile ? .86 : .8)));
    var chromeHeight = Math.max(0, Number(options.chromeHeight) || 0);
    var width = positive(options.width, 640), height = positive(options.height, 360);
    var scale = Math.min(1, Math.max(1, maxWidth - 2) / width, Math.max(1, maxHeight - chromeHeight) / height);
    var mediaWidth = Math.max(1, Math.floor(width * scale));
    var mediaHeight = Math.max(1, Math.floor(height * scale));
    return {
      width: Math.min(maxWidth, Math.max(mediaWidth + 2, Math.min(320, maxWidth))),
      height: Math.min(maxHeight, mediaHeight + chromeHeight),
      mediaWidth: mediaWidth,
      mediaHeight: mediaHeight,
    };
  }

  function attach(card, mediaWrap) {
    var media = null, item = null, frame = null, stopped = false, last = '';
    var win = card.ownerDocument.defaultView;
    var stage = mediaWrap.closest('.lightbox-stage');
    var observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(refresh) : null;

    function chromeElements() {
      return Array.from(card.children).filter(function (child) {
        var style = win.getComputedStyle(child);
        return child !== stage && style.position !== 'absolute' && style.position !== 'fixed' && style.display !== 'none';
      });
    }
    function observeChrome() {
      if (!observer) return;
      observer.disconnect();
      chromeElements().forEach(function (child) { observer.observe(child); });
    }
    function measure() {
      frame = null;
      if (stopped || !media || !card.isConnected) return;
      var nativeWidth = media.videoWidth || media.naturalWidth || item?.width;
      var nativeHeight = media.videoHeight || media.naturalHeight || item?.height;
      var chrome = chromeElements().reduce(function (sum, node) { return sum + node.getBoundingClientRect().height; }, 2);
      var viewport = win.visualViewport;
      var size = fit({ width: nativeWidth, height: nativeHeight,
        viewportWidth: viewport ? viewport.width : win.innerWidth,
        viewportHeight: viewport ? viewport.height : win.innerHeight, chromeHeight: chrome });
      var signature = [size.width, size.height, size.mediaWidth, size.mediaHeight].join(':');
      if (signature === last) return;
      last = signature;
      card.style.setProperty('--viewer-card-width', size.width + 'px');
      card.style.setProperty('--viewer-card-height', size.height + 'px');
      card.style.setProperty('--viewer-media-width', size.mediaWidth + 'px');
      card.style.setProperty('--viewer-media-height', size.mediaHeight + 'px');
    }
    function refresh() {
      if (!stopped && frame === null) frame = win.requestAnimationFrame(measure);
    }
    function unbind() {
      if (!media) return;
      media.removeEventListener('loadedmetadata', refresh);
      media.removeEventListener('load', refresh);
      media.removeEventListener('resize', refresh);
    }
    var mutations = new win.MutationObserver(function () { observeChrome(); refresh(); });
    mutations.observe(card, { childList: true });
    observeChrome();
    win.addEventListener('resize', refresh);
    win.visualViewport?.addEventListener('resize', refresh);
    return {
      setMedia: function (next, details) {
        unbind(); media = next; item = details || {}; last = '';
        if (media) {
          media.addEventListener('loadedmetadata', refresh);
          media.addEventListener('load', refresh);
          media.addEventListener('resize', refresh);
        }
        refresh();
      },
      refresh: refresh,
      stop: function () {
        stopped = true; unbind();
        if (frame !== null) win.cancelAnimationFrame(frame);
        observer?.disconnect(); mutations.disconnect();
        win.removeEventListener('resize', refresh);
        win.visualViewport?.removeEventListener('resize', refresh);
      },
    };
  }

  return { fit: fit, attach: attach };
});
