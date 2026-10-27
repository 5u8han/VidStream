'use strict';

// ImageMagick's `-format "%[pixel:p{0,0}]"` prints things like
// "srgb(50.1946%,37.4487%,46.0822%)" or "srgb(128,96,118)" or
// "#7d6076". CSS's rgb()/rgba() functions accept either all-percentage
// or all-integer channels (this has been valid since CSS2.1), so in
// the common case we only need to swap the ImageMagick colorspace
// prefix for a CSS one. Anything unrecognized falls back to a neutral
// mid-gray so a tile never ends up with `background: undefined`.
function toCssColor(raw) {
  if (!raw) return '#888888';
  const s = raw.trim();

  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;

  const m = s.match(/^s?rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    if (parts.length === 3) return `rgb(${parts.join(',')})`;
    if (parts.length === 4) return `rgba(${parts.join(',')})`;
  }

  const gray = s.match(/^gray\((\d+(?:\.\d+)?%?)\)$/i);
  if (gray) return `rgb(${gray[1]},${gray[1]},${gray[1]})`;

  return '#888888';
}

module.exports = { toCssColor };
