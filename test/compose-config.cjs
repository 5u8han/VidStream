'use strict';

// `node test/compose-config.cjs` resolves temporary Compose configurations.
// It does not start containers, contact Docker Engine, or read the real .env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-compose-'));
const project = 'vidstream-compose-test';
const configFiles = [
  'docker-compose.yml',
  'docker-compose.smb.yml',
  'docker-compose.gpu.yml',
  'docker-compose.nodes-host.yml',
  'docker-compose.ram-cache.yml',
];
// Do not inherit host Compose variables, PORT, secrets or a real .env path.
// HOME/DOCKER_CONFIG allow the CLI to locate its installed Compose plugin.
const cliEnvironment = {};
for (const key of ['PATH', 'HOME', 'DOCKER_CONFIG', 'USERPROFILE', 'SYSTEMROOT',
  'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
  if (process.env[key] !== undefined) cliEnvironment[key] = process.env[key];
}
// Successful resolution must not depend on a reachable Docker daemon.
cliEnvironment.DOCKER_HOST = 'tcp://127.0.0.1:1';
let passed = 0;

function check(name, action) {
  action();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

function writeEnvironment(values = {}) {
  fs.writeFileSync(path.join(temporary, '.env'), Object.entries({
    SMB_HOST: '192.0.2.10',
    SMB_SHARE: 'example-media',
    SMB_USER: 'example-reader',
    SMB_PASS: 'not-a-real-password',
    ...values,
  }).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
}

function resolve(extraFiles = [], expectFailure = false) {
  const args = ['compose', '--project-directory', temporary, '--env-file',
    path.join(temporary, '.env'), '-p', project];
  for (const file of ['docker-compose.yml', ...extraFiles]) {
    args.push('-f', path.join(temporary, file));
  }
  args.push('config', '--format', 'json');
  const result = spawnSync('docker', args, {
    cwd: temporary,
    env: cliEnvironment,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const diagnostic = (result.stderr || '').trim().slice(0, 1200);
  if (expectFailure) {
    assert.notEqual(result.status, 0, 'An incomplete explicit media mount must fail');
    assert.match(diagnostic, /STREAM_MEDIA_PATH/, 'The error must identify the missing setting');
    return;
  }
  assert.equal(result.status, 0, `Compose configuration failed: ${diagnostic}`);
  return JSON.parse(result.stdout);
}

function mount(config, target) {
  const entries = config.services.stream.volumes.filter(x => x.target === target);
  assert.equal(entries.length, 1, `Expected exactly one mount for ${target}`);
  return entries[0];
}

function persistentVolumes(config) {
  for (const [key, target] of [['stream-data', '/app/data'], ['stream-cache', '/app/.cache']]) {
    const item = mount(config, target);
    assert.equal(item.type, 'volume');
    assert.equal(item.source, key);
    assert.equal(config.volumes[key].name, `${project}_${key}`);
  }
}

function fixedContainerSettings(config) {
  const env = config.services.stream.environment;
  assert.equal(env.PORT, '4000');
  assert.equal(env.HOST, '0.0.0.0');
  assert.equal(env.MEDIA_DIR, '/media/original');
  assert.equal(env.CACHE_DIR, '/app/.cache');
  assert.equal(env.DATA_DIR, '/app/data');
  assert.equal(env.ORIGINALS_DIR, '/app/originals/original');
}

function enableCommentedMediaBind(text) {
  // Activate the shipped example itself so indentation, interpolation and
  // mount behavior are verified together instead of reconstructing the YAML.
  const lines = text.split('\n');
  const start = lines.findIndex((line, i) => /# - type: bind\s*$/.test(line) &&
    /#\s+source:\s+\$\{STREAM_MEDIA_PATH/.test(lines[i + 1] || ''));
  assert.notEqual(start, -1, 'Expected a commented host-media example');
  let end = start + 1;
  while (end < lines.length && /^\s*# (?: {2,}\S)/.test(lines[end])) end++;
  for (let i = start; i < end; i++) lines[i] = lines[i].replace(/^(\s*)# /, '$1');
  return lines.join('\n');
}

try {
  for (const file of configFiles) fs.copyFileSync(path.join(source, file), path.join(temporary, file));
  const originalBase = fs.readFileSync(path.join(temporary, 'docker-compose.yml'), 'utf8');
  writeEnvironment();
  const base = resolve();

  check('default host HTTP port is 80 while the container listens on 4000', () => {
    const ports = base.services.stream.ports;
    assert.equal(ports.length, 1);
    assert.equal(ports[0].published, '80');
    assert.equal(ports[0].target, 4000);
    fixedContainerSettings(base);
  });

  check('a fresh configuration does not bind any host media directory', () => {
    assert.equal(base.services.stream.volumes.some(x => x.target === '/media/original'), false);
    assert.equal(base.services.stream.volumes.some(x => x.type === 'bind'), false);
    assert.equal(base.services.stream.environment.STREAM_MEDIA_PATH, '');
    assert.equal(base.services.stream.environment.STREAM_ORIGINALS_PATH, '');
  });

  check('catalog and cache names are stable, with persistent default archives', () => {
    persistentVolumes(base);
    const originals = mount(base, '/app/originals');
    assert.equal(originals.type, 'volume');
    assert.equal(originals.source, 'stream-originals');
    assert.equal(base.volumes['stream-originals'].name, `${project}_stream-originals`);
  });

  const defaultHostNetwork = resolve(['docker-compose.nodes-host.yml']);
  check('host networking defaults to standard HTTP without publishing a second port', () => {
    assert.equal(defaultHostNetwork.services.stream.network_mode, 'host');
    assert.equal(defaultHostNetwork.services.stream.environment.PORT, '80');
    assert.equal((defaultHostNetwork.services.stream.ports || []).length, 0);
    persistentVolumes(defaultHostNetwork);
  });

  writeEnvironment({ STREAM_HTTP_PORT: 8080, PORT: 1234, MEDIA_DIR: '/host-only-media', CACHE_DIR: '/host-only-cache' });
  const customPort = resolve();
  check('a custom published port does not alter Docker internal paths or port', () => {
    assert.equal(customPort.services.stream.ports[0].published, '8080');
    assert.equal(customPort.services.stream.ports[0].target, 4000);
    fixedContainerSettings(customPort);
    persistentVolumes(customPort);
  });

  const hostNetwork = resolve(['docker-compose.nodes-host.yml']);
  check('host networking listens on the selected host port without published ports', () => {
    assert.equal(hostNetwork.services.stream.network_mode, 'host');
    assert.equal((hostNetwork.services.stream.ports || []).length, 0);
    assert.equal(hostNetwork.services.stream.environment.PORT, '8080');
    assert.equal(hostNetwork.services.stream.environment.MEDIA_DIR, '/media/original');
    persistentVolumes(hostNetwork);
  });

  const mediaFolder = path.join(temporary, 'chosen media with spaces');
  fs.mkdirSync(mediaFolder);
  writeEnvironment({ STREAM_MEDIA_PATH: mediaFolder });
  check('setting the host path alone leaves the media example opt-in', () => {
    const config = resolve();
    assert.equal(config.services.stream.volumes.some(x => x.target === '/media/original'), false);
    assert.equal(config.services.stream.environment.STREAM_MEDIA_PATH, '');
  });

  fs.writeFileSync(path.join(temporary, 'docker-compose.yml'), enableCommentedMediaBind(originalBase));
  const explicit = resolve();
  check('the uncommented example resolves a read-only existing host folder with spaces', () => {
    const media = mount(explicit, '/media/original');
    assert.equal(media.type, 'bind');
    assert.equal(media.source, mediaFolder);
    assert.equal(media.read_only, true);
    // Compose versions differ in whether explicit false values survive JSON
    // serialization. Both omitted and false represent the disabled setting;
    // an enabled host-path creation flag must never pass this check.
    assert.notEqual(media.bind.create_host_path, true);
    assert.equal(explicit.services.stream.environment.STREAM_MEDIA_PATH, '');
    fixedContainerSettings(explicit);
    persistentVolumes(explicit);
  });

  writeEnvironment();
  check('an enabled media bind rejects a missing host path', () => resolve([], true));
  writeEnvironment({ STREAM_MEDIA_PATH: '' });
  check('an enabled media bind rejects a blank host path', () => resolve([], true));

  fs.writeFileSync(path.join(temporary, 'docker-compose.yml'), originalBase);
  writeEnvironment();
  const smb = resolve(['docker-compose.smb.yml']);
  check('the SMB overlay uses read-only media and preserves local application volumes', () => {
    const media = mount(smb, '/media/original');
    assert.equal(media.type, 'volume');
    assert.equal(media.source, 'smb-media');
    assert.equal(media.read_only, true);
    assert.equal(smb.volumes['smb-media'].driver_opts.type, 'cifs');
    assert.equal(smb.volumes['smb-media'].driver_opts.device, '//192.0.2.10/example-media');
    assert.equal(smb.services.stream.environment.WATCH_FOR_CHANGES, '0');
    assert.equal(smb.services.stream.environment.RESCAN_INTERVAL_MINUTES, '15');
    fixedContainerSettings(smb);
    persistentVolumes(smb);
  });

  const gpu = resolve(['docker-compose.gpu.yml']);
  check('the GPU overlay adds device access without changing media or persistent storage', () => {
    assert.equal(gpu.services.stream.gpus[0].count, -1);
    assert.equal(gpu.services.stream.environment.NVIDIA_VISIBLE_DEVICES, 'all');
    assert.equal(gpu.services.stream.environment.NVIDIA_DRIVER_CAPABILITIES, 'compute,utility,graphics,video');
    assert.equal(gpu.services.stream.volumes.some(x => x.target === '/media/original'), false);
    fixedContainerSettings(gpu);
    persistentVolumes(gpu);
  });

  const combined = resolve(['docker-compose.smb.yml', 'docker-compose.gpu.yml']);
  check('SMB and GPU overlays can be combined without displacing catalog or archives', () => {
    assert.equal(mount(combined, '/media/original').source, 'smb-media');
    assert.equal(mount(combined, '/media/original').read_only, true);
    assert.equal(mount(combined, '/app/originals').source, 'stream-originals');
    assert.equal(combined.services.stream.gpus[0].count, -1);
    persistentVolumes(combined);
  });

  const legacyMedia = path.join(temporary, 'existing media');
  const legacyOriginals = path.join(temporary, 'existing originals');
  fs.mkdirSync(legacyMedia);
  fs.mkdirSync(legacyOriginals);
  fs.writeFileSync(path.join(temporary, 'existing.yml'), `services:
  stream:
    volumes:
      - type: bind
        source: ${JSON.stringify(legacyMedia)}
        target: /media/original
      - type: bind
        source: ${JSON.stringify(legacyOriginals)}
        target: /app/originals
volumes:
  stream-data:
    external: true
    name: existing_stream-data
  stream-cache:
    external: true
    name: existing_stream-cache
`);
  const existing = resolve(['existing.yml']);
  check('existing external catalog/cache and custom media/archive binds survive the update', () => {
    assert.equal(mount(existing, '/media/original').type, 'bind');
    assert.equal(mount(existing, '/media/original').source, legacyMedia);
    assert.equal(mount(existing, '/app/originals').type, 'bind');
    assert.equal(mount(existing, '/app/originals').source, legacyOriginals);
    for (const [key, target] of [['stream-data', '/app/data'], ['stream-cache', '/app/.cache']]) {
      assert.equal(mount(existing, target).source, key);
      assert.equal(existing.volumes[key].external, true);
      assert.equal(existing.volumes[key].name, `existing_${key}`);
    }
    fixedContainerSettings(existing);
  });

  writeEnvironment();
  const ram = resolve(['docker-compose.ram-cache.yml']);
  check('RAM cache replaces only its runtime mount and reuses the named cache volume for snapshots', () => {
    const runtime = mount(ram, '/app/.cache'), snapshot = mount(ram, '/app/cache-snapshot');
    assert.equal(runtime.type, 'tmpfs');
    assert.equal(Number(runtime.tmpfs.size), 1073741824);
    assert.equal(runtime.tmpfs.mode, 448);
    assert.equal(snapshot.type, 'volume'); assert.equal(snapshot.source, 'stream-cache');
    assert.equal(mount(ram, '/app/data').source, 'stream-data');
    assert.equal(mount(ram, '/app/originals').source, 'stream-originals');
    assert.equal(ram.services.stream.environment.CACHE_SNAPSHOT_DIR, '/app/cache-snapshot/.ram-cache');
    assert.equal(ram.services.stream.environment.CACHE_COLD_START, '0');
    assert.equal(Number(ram.services.stream.mem_limit), 4294967296);
    assert.equal(ram.services.stream.memswap_limit, ram.services.stream.mem_limit);
    assert.ok(ram.services.stream.stop_grace_period);
  });
  const ramExisting = resolve(['existing.yml', 'docker-compose.ram-cache.yml']);
  check('RAM cache retains existing external volumes and custom media/archive mounts', () => {
    assert.equal(mount(ramExisting, '/media/original').source, legacyMedia);
    assert.equal(mount(ramExisting, '/app/originals').source, legacyOriginals);
    assert.equal(mount(ramExisting, '/app/cache-snapshot').source, 'stream-cache');
    assert.equal(ramExisting.volumes['stream-cache'].name, 'existing_stream-cache');
    assert.equal(ramExisting.volumes['stream-cache'].external, true);
    assert.equal(ramExisting.volumes['stream-data'].external, true);
  });
  writeEnvironment({ STREAM_RAM_CACHE_SIZE: 268435456, STREAM_MEM_LIMIT: '3g', STREAM_CACHE_COLD_START: '1', STREAM_CACHE_STOP_GRACE: '8m' });
  const customRam = resolve(['docker-compose.ram-cache.yml']);
  check('RAM cache size, container memory, cold start and shutdown grace are explicit independent choices', () => {
    assert.equal(Number(mount(customRam, '/app/.cache').tmpfs.size), 268435456);
    assert.equal(Number(customRam.services.stream.mem_limit), 3221225472);
    assert.equal(customRam.services.stream.memswap_limit, customRam.services.stream.mem_limit);
    assert.equal(customRam.services.stream.environment.CACHE_COLD_START, '1');
    assert.notEqual(customRam.services.stream.stop_grace_period, ram.services.stream.stop_grace_period);
  });
  console.log(`${passed} Compose configuration checks passed; no containers started or data changed.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
