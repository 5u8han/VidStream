'use strict';

const { execFile } = require('node:child_process');
const { statfs } = require('node:fs/promises');
const { resolve } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

function allocatedCapacity(stat, unit) {
  return { freeBytes: stat.bavail * unit, totalBytes: stat.blocks * unit, type: stat.type };
}

async function filesystemCapacity(dir) {
  const stat = await statfs(dir, { bigint: true });
  if (stat.frsize > 0n) return allocatedCapacity(stat, stat.frsize);
  if (process.platform === 'win32') return allocatedCapacity(stat, stat.bsize);

  const { stdout } = await run('df', ['-Pk', resolve(dir)], {
    env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024, timeout: 3000,
  });
  const line = stdout.trimEnd().split('\n').at(-1);
  const sizes = /\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+/.exec(line);
  if (!sizes) throw Error('Could not determine the filesystem block size');
  return { totalBytes: BigInt(sizes[1]) * 1024n, freeBytes: BigInt(sizes[3]) * 1024n, type: stat.type };
}

module.exports = { filesystemCapacity };
