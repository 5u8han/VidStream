(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StreamPreviewMemory = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create({
    budget = 1024 ** 3,
    maximumClip = 16 * 1024 * 1024,
    maximumTransfers = 4,
    timeout = 2500,
    request = fetch,
    makeUrl = blob => URL.createObjectURL(blob),
    revoke = url => URL.revokeObjectURL(url)
  } = {}) {
    var clips = new Map(), downloads = new Map(), bytes = 0, hits = 0;

    function remove(key, entry) {
      clips.delete(key);
      entry.retained = false;
      if (!entry.uses) {
        bytes -= entry.bytes;
        revoke(entry.url);
      }
    }

    function makeRoom(size) {
      for (var [key, entry] of clips) {
        if (bytes + size <= budget) break;
        if (!entry.uses) remove(key, entry);
      }
      return bytes + size <= budget;
    }

    async function download(key, controller) {
      var deadline = setTimeout(() => controller.abort(), timeout);
      try {
        var response = await request(key, {
          cache: 'no-store', credentials: 'same-origin', signal: controller.signal
        });
        var length = Number(response.headers.get('Content-Length'));
        var type = response.headers.get('Content-Type');
        if (response.status !== 200 || type !== 'video/mp4' ||
            !Number.isSafeInteger(length) || length <= 0 || length > Math.min(maximumClip, budget) || !response.body) {
          controller.abort();
          return null;
        }

        var reader = response.body.getReader(), parts = [], size = 0;
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > length) {
            controller.abort();
            return null;
          }
          parts.push(chunk.value);
        }
        if (controller.signal.aborted || size !== length || !makeRoom(size)) return null;
        var entry = { url: makeUrl(new Blob(parts, { type })), bytes: size, uses: 0, retained: true };
        clips.set(key, entry);
        bytes += size;
        return entry;
      } catch (_) { return null; }
      finally { clearTimeout(deadline); }
    }

    async function acquire(key) {
      if (!budget) return null;
      var entry = clips.get(key), transfer = downloads.get(key);
      if (entry) hits++;
      else {
        if (!transfer) {
          if (downloads.size >= maximumTransfers) return null;
          var controller = new AbortController();
          transfer = { controller, promise: download(key, controller) };
          downloads.set(key, transfer);
        }
        entry = await transfer.promise;
        if (downloads.get(key) === transfer) downloads.delete(key);
      }
      if (!entry || !entry.retained) return null;
      clips.delete(key);
      clips.set(key, entry);
      entry.uses++;
      var released = false;
      return {
        url: entry.url,
        release: function () {
          if (released) return;
          released = true;
          if (--entry.uses === 0 && !entry.retained) {
            bytes -= entry.bytes;
            revoke(entry.url);
          }
        }
      };
    }

    function discard(key) {
      var entry = clips.get(key);
      if (entry) remove(key, entry);
    }

    function clear() {
      for (var transfer of downloads.values()) transfer.controller.abort();
      downloads.clear();
      for (var [key, entry] of clips) remove(key, entry);
    }

    function setBudget(next) {
      if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Invalid preview memory budget');
      budget = next;
      if (!budget || bytes > budget) clear();
    }

    return {
      acquire,
      discard,
      clear,
      setBudget,
      stats: () => ({ clips: clips.size, bytes, limitBytes: budget, hits, downloads: downloads.size })
    };
  }

  return { create };
});
