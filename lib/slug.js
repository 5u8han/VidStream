'use strict';
const crypto = require('crypto');

// Turn a filename into a URL-safe slug, matching the spirit of the
// original project's permalinks (lowercase, hyphenated, extension
// stripped). Collisions (two files that slugify to the same string)
// get a short stable hash suffix so links never break across a rescan.
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function shortHash(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6);
}

// existingSlugs: Set of slugs already assigned this scan pass, so two
// files in the same batch never collide either.
function slugFor(relPath, existingSlugs) {
  const base = slugify(relPath.split('/').pop());
  if (!existingSlugs.has(base)) {
    existingSlugs.add(base);
    return base;
  }
  const withHash = `${base}-${shortHash(relPath)}`;
  existingSlugs.add(withHash);
  return withHash;
}

module.exports = { slugify, slugFor, shortHash };
