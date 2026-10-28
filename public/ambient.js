/* Ambient animated background + hover effects. Self-contained: app.js
 * calls StreamAmbient.start() once and feeds it events; if this file
 * fails to load, the app simply runs without it. All the numbers that
 * shape the look live in the block below -- tune there. */
(function () {
  'use strict';

  var SCALE = 0.5;             // canvas resolution vs. CSS px: lower = softer and cheaper
  var FADE_ALPHA = 0.085;      // per-frame wash toward the page color: lower = longer trails
  var MAX_BLOBS = 36;
  var TILE_EMIT_GAP_MS = 150;  // per-tile cooldown for scroll-trail emission
  var MOUSE_EMIT_PX = 22;      // pointer travel between cursor blobs
  var IDLE_EMIT_MS = 1400;     // cadence of slow ambient blobs with no interaction
  var ATTRACT = 0.00018;       // how strongly blobs drift toward the pointer
  var PARALLAX = 0.07;         // pointer-relative blob offset per unit of depth
  var MAX_SMEAR_SPEED = 14;    // clamp on a scroll-trail blob's initial speed (canvas px/frame)

  function parseColor(str) {
    if (!str) return [136, 136, 136];
    var s = String(str).trim(), m;
    if ((m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i))) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    if ((m = s.match(/^rgba?\(([^)]+)\)$/i))) {
      var p = m[1].split(',').slice(0, 3).map(function (v) {
        v = v.trim();
        return v.slice(-1) === '%' ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v));
      });
      if (p.length === 3 && p.every(isFinite)) return p;
    }
    return [136, 136, 136];
  }

  // A tile's dominant color is an *average*, so it tends to be muddy;
  // push channels away from their mean so trails read as color.
  function vivid(rgb) {
    var mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return rgb.map(function (c) {
      return Math.max(0, Math.min(255, Math.round(mean + (c - mean) * 1.7 + 12)));
    });
  }

  var api = null;

  function start(opts) {
    if (api) return api;
    opts = opts || {};
    if (opts.reducedMotion || opts.lite) return null;   // accessibility + Data saver: no animated background
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    canvas.className = 'ambient-bg';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    document.body.classList.add('has-ambient');

    var W = 2, H = 2;
    function resize() {
      W = Math.max(2, Math.round(window.innerWidth * SCALE));
      H = Math.max(2, Math.round(window.innerHeight * SCALE));
      canvas.width = W;
      canvas.height = H;
    }
    resize();
    window.addEventListener('resize', resize);

    var blobs = [];
    var mouse = { x: W / 2, y: H / 2, sx: W / 2, sy: H / 2, ex: null, ey: null };
    var hoverColor = null, lastColor = null;
    var scrollVel = 0, lastScrollY = window.scrollY || 0;
    var visibleTiles = new Set();
    var bgRGB = [18, 16, 18], accentStr = '#c1443c';
    var frames = 0, lastIdle = 0, lastBeat = 0;
    var audioCtx = null, analyser = null, freqBuf = null, activeSource = null;
    var audioLevel = 0, audioAvg = 0, spawnedTotal = 0;

    function spawn(x, y, rgb, r, vx, vy, life, depth, friction) {
      spawnedTotal++;
      if (blobs.length >= MAX_BLOBS) blobs.shift();
      blobs.push({
        x: x, y: y, vx: vx, vy: vy, r: r, c: rgb, life: life, depth: depth,
        fr: friction || 0.985, decay: 0.0045 + Math.random() * 0.004,
      });
    }

    var tileObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting && e.target.isConnected !== false) visibleTiles.add(e.target);
            else {
              visibleTiles.delete(e.target);
              if (e.target.isConnected === false) tileObserver.unobserve(e.target);
            }
          });
        })
      : null;

    // Tiles that just scrolled past leave a lingering smear of their own
    // dominant color: it starts moving with the tile, then (friction)
    // falls behind it and fades -- a wake, not a particle burst.
    function emitScrollTrail(now) {
      var down = scrollVel > 0;
      var vh = window.innerHeight;
      var bandTop = down ? 0 : vh * 0.72;
      var bandBottom = down ? vh * 0.28 : vh;
      visibleTiles.forEach(function (tile) {
        if (now - (tile._bgLast || 0) < TILE_EMIT_GAP_MS) return;
        var r = tile.getBoundingClientRect();
        var cy = r.top + r.height / 2;
        if (cy < bandTop || cy > bandBottom) return;
        tile._bgLast = now;
        lastColor = tile._bgColor;
        var vy = Math.max(-MAX_SMEAR_SPEED, Math.min(MAX_SMEAR_SPEED, -scrollVel * SCALE * 0.55));
        var size = Math.max(r.width, r.height) * SCALE * (0.7 + Math.random() * 0.5);
        spawn((r.left + r.width / 2) * SCALE, cy * SCALE, vivid(parseColor(tile._bgColor)), size,
          (Math.random() - 0.5) * 0.4, vy, 0.9, 0.5 + Math.random() * 0.9, 0.93);
      });
    }

    function readAudio() {
      if (analyser && activeSource) {
        analyser.getByteFrequencyData(freqBuf);
        var n = Math.max(1, freqBuf.length >> 1), sum = 0;
        for (var i = 0; i < n; i++) sum += freqBuf[i];
        audioLevel += ((sum / n / 255) - audioLevel) * 0.35;
      } else {
        audioLevel *= 0.9;
      }
      return audioLevel;
    }

    function audioBeat(level, now) {
      audioAvg += (level - audioAvg) * 0.04;
      if (level > audioAvg * 1.35 + 0.04 && now - lastBeat > 180) {
        lastBeat = now;
        spawn(W * (0.2 + Math.random() * 0.6), H * (0.25 + Math.random() * 0.5),
          vivid(parseColor(lastColor || accentStr)), Math.min(W, H) * (0.2 + level * 0.5),
          (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, 0.8, 0.5 + Math.random(), 0.97);
      }
    }

    function frame(t) {
      requestAnimationFrame(frame);
      if (document.hidden) return;
      var now = t || Date.now();

      // Follow theme changes (the CSS variables are the source of truth).
      if (frames % 90 === 0) {
        var cs = getComputedStyle(document.documentElement);
        bgRGB = parseColor(cs.getPropertyValue('--bg'));
        accentStr = cs.getPropertyValue('--accent') || accentStr;
      }
      frames++;

      // Wash toward the page color so everything leaves a trail.
      ctx.globalCompositeOperation = 'source-over';
      var a = FADE_ALPHA;
      ctx.fillStyle = 'rgba(' + bgRGB[0] + ',' + bgRGB[1] + ',' + bgRGB[2] + ',' + a + ')';
      ctx.fillRect(0, 0, W, H);

      scrollVel *= 0.9;
      if (Math.abs(scrollVel) > 1.5) emitScrollTrail(now);

      mouse.sx += (mouse.x - mouse.sx) * 0.12;
      mouse.sy += (mouse.y - mouse.sy) * 0.12;

      if (now - lastIdle > IDLE_EMIT_MS) {
        lastIdle = now;
        var size = (0.12 + Math.random() * 0.18) * Math.min(W, H);
        spawn(Math.random() * W, Math.random() * H, vivid(parseColor(lastColor || accentStr)), size,
          (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, 0.55, 0.3 + Math.random() * 0.7);
      }

      var level = readAudio();
      if (level > 0.02) audioBeat(level, now);

      var offX = mouse.sx - W / 2, offY = mouse.sy - H / 2;
      for (var i = blobs.length - 1; i >= 0; i--) {
        var b = blobs[i];
        b.vx += (mouse.sx - b.x) * ATTRACT * b.depth;   // drift toward the pointer
        b.vy += (mouse.sy - b.y) * ATTRACT * b.depth;
        b.vx *= b.fr; b.vy *= b.fr;
        b.x += b.vx; b.y += b.vy;
        b.life -= b.decay;
        if (b.life <= 0) { blobs.splice(i, 1); continue; }
        var px = b.x + offX * PARALLAX * b.depth;       // pointer-relative parallax by depth
        var py = b.y + offY * PARALLAX * b.depth;
        var rad = b.r * (1 + (1 - b.life) * 0.6) * (1 + audioLevel * 0.9);
        var alpha = Math.min(1, b.life) * 0.55 * (1 + audioLevel * 0.8);
        var g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0, 'rgba(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ',' + alpha + ')');
        g.addColorStop(1, 'rgba(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
      }
    }

    window.addEventListener('scroll', function () {
      var y = window.scrollY || 0;
      scrollVel += y - lastScrollY;
      lastScrollY = y;
    }, { passive: true });

    window.addEventListener('pointermove', function (e) {
      mouse.x = e.clientX * SCALE;
      mouse.y = e.clientY * SCALE;
      if (mouse.ex === null) { mouse.ex = mouse.x; mouse.ey = mouse.y; }
      var dx = mouse.x - mouse.ex, dy = mouse.y - mouse.ey;
      var step = MOUSE_EMIT_PX * SCALE;
      if (dx * dx + dy * dy > step * step) {
        mouse.ex = mouse.x; mouse.ey = mouse.y;
        spawn(mouse.x, mouse.y, vivid(parseColor(hoverColor || lastColor || accentStr)),
          (18 + Math.random() * 22) * SCALE * 2.2, dx * 0.04, dy * 0.04, 0.7, 0.4 + Math.random() * 0.6, 0.96);
      }
    }, { passive: true });

    window.addEventListener('pointerdown', function(e) {
      if (e.target.closest('button, a, input, select')) return;
      spawn(e.clientX*SCALE,e.clientY*SCALE,vivid(parseColor(hoverColor||accentStr)),60*SCALE,0,0,.65,.3);
    }, {passive:true});
    requestAnimationFrame(frame);

    api = {
      watchTile: function (tile, color) {
        tile._bgColor = color;
        if (tileObserver) tileObserver.observe(tile);
      },
      setHoverColor: function (color) { hoverColor = color; lastColor = color || lastColor; },

      // Taps the lightbox video's audio so the background can pulse with
      // it. Wiring an element into a *suspended* AudioContext would
      // silence the video, so this only connects when the context is
      // actually running (e.g. created inside the click that opened the
      // lightbox) and otherwise leaves playback completely untouched.
      attachAudio: function (media) {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          if (!audioCtx) audioCtx = new AC();
          if (audioCtx.state === 'suspended') audioCtx.resume();
          if (audioCtx.state !== 'running') return;
          if (!analyser) {
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            analyser.connect(audioCtx.destination);
            freqBuf = new Uint8Array(analyser.frequencyBinCount);
          }
          var src = audioCtx.createMediaElementSource(media);
          src.connect(analyser);
          activeSource = src;
        } catch (e) { activeSource = null; }
      },
      detachAudio: function () {
        if (activeSource) { try { activeSource.disconnect(); } catch (e) { /* already gone */ } }
        activeSource = null;
      },
      debug: function () { return { blobs: blobs.length, spawned: spawnedTotal, visibleTiles: visibleTiles.size, audioLevel: audioLevel }; },
    };
    return api;
  }

  // Header/footer hover: a spotlight that follows the pointer, a
  // fainter wider ghost of it that trails well behind (the "trail"),
  // and CSS-variable parallax (--px/--py in -1..1) that children read.
  // Both followers are eased in JS, so no CSS transition is involved.
  function bindHoverFx(host) {
    if (!host || !window.matchMedia) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!matchMedia('(hover: hover)').matches) return;
    var tx = 0, ty = 0, cx = 0, cy = 0, hx = 0, hy = 0, active = false, raf = 0;
    function w() { return host.clientWidth || 1; }
    function h() { return host.clientHeight || 1; }
    function apply() {
      host.style.setProperty('--fx-x', cx.toFixed(1) + 'px');
      host.style.setProperty('--fx-y', cy.toFixed(1) + 'px');
      host.style.setProperty('--fx-tx', hx.toFixed(1) + 'px');
      host.style.setProperty('--fx-ty', hy.toFixed(1) + 'px');
      host.style.setProperty('--px', (((cx / w()) - 0.5) * 2).toFixed(3));
      host.style.setProperty('--py', (((cy / h()) - 0.5) * 2).toFixed(3));
    }
    function step() {
      raf = 0;
      cx += (tx - cx) * 0.2;  cy += (ty - cy) * 0.2;      // spotlight follows quickly...
      hx += (tx - hx) * 0.055; hy += (ty - hy) * 0.055;   // ...its ghost lags well behind
      apply();
      var settled = Math.abs(tx - cx) < 0.4 && Math.abs(ty - cy) < 0.4 &&
                    Math.abs(tx - hx) < 0.4 && Math.abs(ty - hy) < 0.4;
      if (!settled) raf = requestAnimationFrame(step);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(step); }
    host.addEventListener('pointermove', function (e) {
      var r = host.getBoundingClientRect();
      tx = e.clientX - r.left; ty = e.clientY - r.top;
      if (!active) { active = true; cx = hx = tx; cy = hy = ty; host.classList.add('fx-on'); }
      kick();
    });
    host.addEventListener('pointerleave', function () {
      active = false;
      host.classList.remove('fx-on');
      tx = w() / 2; ty = h() / 2;     // glide back to rest; parallax settles to zero
      kick();
    });
  }

  window.StreamAmbient = { start: start, bindHoverFx: bindHoverFx };
})();
