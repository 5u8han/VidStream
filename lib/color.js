'use strict';

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
