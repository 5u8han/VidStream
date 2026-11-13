'use strict';
const crypto = require('crypto');

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

function slugFor(relPath, existingSlugs) {
  const base = slugify(relPath.split('/').pop());
  if (!existingSlugs.has(base)) {
    existingSlugs.add(base);
    return base;
  }
  const withHash = `${base}-${shortHash(relPath)}`;
  let candidate = withHash;
  for (let suffix = 2; existingSlugs.has(candidate); suffix++) candidate = `${withHash}-${suffix}`;
  existingSlugs.add(candidate);
  return candidate;
}

module.exports = { slugify, slugFor, shortHash };
