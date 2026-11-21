'use strict';

function fileIdentity(stat) {
  return [stat.ino, stat.birthtimeMs, stat.ctimeMs].join(':');
}

function canReuseHash(item, stat) {
  if (!item?.sourceHash || item.size !== stat.size) return false;
  if (item.scanFileIdentity && item.scanFileIdentity !== fileIdentity(stat)) return false;
  if (item.fingerprint) return item.fingerprint.startsWith(stat.mtimeMs + ':' + stat.size + ':');
  return item.mtime === stat.mtime.toISOString();
}

function assertSameSource(before, after) {
  const differences = [];
  if (!after.isFile()) differences.push('file type');
  if (before.dev !== after.dev) differences.push('device');
  if (before.ino !== after.ino) differences.push('file identity');
  if (before.size !== after.size) differences.push('size ' + before.size + ' → ' + after.size + ' bytes');
  if (before.mtimeMs !== after.mtimeMs) differences.push('modification time');
  if (before.ctimeMs !== after.ctimeMs) differences.push('file change time');
  if (differences.length) {
    throw Error('Source changed during processing (' + differences.join(', ') + '). Retry after the file and its mount are stable.');
  }
}

module.exports = { fileIdentity, canReuseHash, assertSameSource };
