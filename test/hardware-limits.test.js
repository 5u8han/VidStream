'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryLimit, cpuQuota, cpusetCount, resourceLimits } = require('../lib/hardware-limits');
const GiB = 1073741824;

test('hardware limits distinguish real ceilings from cgroup unlimited sentinels', () => {
  assert.equal(memoryLimit('2147483648', 16 * GiB), 2 * GiB);
  for (const value of ['max', '-1', '0', '9223372036854771712', 'invalid']) assert.equal(memoryLimit(value, 16 * GiB), null);
  assert.equal(memoryLimit(String(32 * GiB), 16 * GiB), 32 * GiB); // A real but ineffective cap above VM RAM remains visible.
  assert.equal(cpuQuota('250000 100000'), 2.5);
  assert.equal(cpuQuota('50000', '100000'), .5);
  for (const raw of ['max 100000', '-1 100000', '0 100000', '1000 0', 'bad']) assert.equal(cpuQuota(raw), null);
});

test('CPU affinity lists handle ranges, overlap and malformed input', () => {
  assert.equal(cpusetCount('0-3,6,8-9'), 7);
  assert.equal(cpusetCount('0-3,2-5,4'), 6);
  for (const raw of ['', '4-1', '1,x', '1-', '1.5']) assert.equal(cpusetCount(raw), null);
});

test('effective resources are constrained by RAM cap, affinity, cpuset and CPU quota', () => {
  const files = {
    '/sys/fs/cgroup/memory.max': String(2 * GiB),
    '/sys/fs/cgroup/cpu.max': '150000 100000',
    '/sys/fs/cgroup/cpuset.cpus.effective': '0-3',
  };
  const limits = resourceLimits({ readFile: path => files[path] || '', exists: path => path === '/.dockerenv', platform: 'linux', hostBytes: 16 * GiB, logicalThreads: 12, affinity: 8 });
  assert.equal(limits.effectiveMemoryBytes, 2 * GiB);
  assert.equal(limits.hostBytes, 16 * GiB);
  assert.equal(limits.availableThreads, 4);
  assert.equal(limits.effectiveCores, 1.5);
  assert.equal(limits.containerized, true);
  assert.match(limits.scope, /VM/);
});

test('native hosts and unlimited containers retain OS-visible resources', () => {
  const limits = resourceLimits({ readFile: () => '', exists: () => false, platform: 'darwin', hostBytes: 36 * GiB, logicalThreads: 12, affinity: 10 });
  assert.equal(limits.memoryLimitBytes, null);
  assert.equal(limits.cpuQuotaCores, null);
  assert.equal(limits.effectiveMemoryBytes, 36 * GiB);
  assert.equal(limits.effectiveCores, 10);
  assert.equal(limits.containerized, false);
});
