'use strict';
const fs = require('node:fs');
const os = require('node:os');

function memoryLimit(raw) {
  if (!/^\d+$/.test(String(raw || '').trim())) return null;
  const value = Number(String(raw).trim());
  // cgroup v1 uses huge sentinel values for an unrestricted process.
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function cpuQuota(raw, period) {
  const parts = String(raw || '').trim().split(/\s+/);
  const quota = Number(parts[0]), interval = Number(period === undefined ? parts[1] : period);
  return Number.isFinite(quota) && quota > 0 && Number.isFinite(interval) && interval > 0 ? quota / interval : null;
}
function cpusetCount(raw) {
  const parts = String(raw || '').trim().split(',');
  if (!parts[0]) return null;
  const ranges = [];
  for (const part of parts) {
    if (!/^\d+(?:-\d+)?$/.test(part)) return null;
    const [start, givenEnd] = part.split('-').map(Number), end = givenEnd === undefined ? start : givenEnd;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let count = 0, previous = -1;
  for (const [start, end] of ranges) { count += Math.max(0, end - Math.max(start, previous + 1) + 1); previous = Math.max(previous, end); }
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}
function read(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function resourceLimits({ readFile = read, exists = fs.existsSync, platform = process.platform, hostBytes = os.totalmem(), logicalThreads = os.cpus().length || 1, affinity = os.availableParallelism ? os.availableParallelism() : os.cpus().length || 1 } = {}) {
  const memory = [readFile('/sys/fs/cgroup/memory.max'), readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')].map(raw => memoryLimit(raw, hostBytes)).filter(v => v !== null);
  const quotas = [cpuQuota(readFile('/sys/fs/cgroup/cpu.max')), cpuQuota(readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us')), cpuQuota(readFile('/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us'), readFile('/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us'))].filter(v => v !== null);
  const sets = [readFile('/sys/fs/cgroup/cpuset.cpus.effective'), readFile('/sys/fs/cgroup/cpuset/cpuset.cpus')].map(cpusetCount).filter(v => v !== null);
  const limit = memory.length ? Math.min(...memory) : null, quota = quotas.length ? Math.min(...quotas) : null;
  const available = Math.min(affinity, logicalThreads, ...(sets.length ? sets : [logicalThreads]));
  const containerized = platform === 'linux' && (exists('/.dockerenv') || exists('/run/.containerenv') || /docker|containerd|kubepods|lxc/.test(readFile('/proc/1/cgroup')));
  return { hostBytes, memoryLimitBytes: limit, effectiveMemoryBytes: Math.min(hostBytes, limit || hostBytes), logicalThreads, availableThreads: available,
    cpuQuotaCores: quota, effectiveCores: Math.min(available, quota || available), containerized,
    scope: containerized ? 'Container; OS totals may describe its VM rather than the physical machine' : 'Operating system visible to VidStream (may itself be a VM)' };
}
module.exports = { memoryLimit, cpuQuota, cpusetCount, resourceLimits };
