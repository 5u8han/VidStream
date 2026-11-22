'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { isIPv4 } = require('node:net');
const { posix, win32 } = require('node:path');

const MEDIA_ROOT = '/media/collections';
const PORTABLE_DIRECTORY = 'vidstream-local';
const STORAGE = new Map([
  ['data', '/app/data'],
  ['cache', '/app/.cache'],
  ['originals', '/app/originals']
]);
const THEMES = new Set(['light-table', 'darkroom', 'system']);

function yamlString(value) {
  return JSON.stringify(value.replace(/\$/g, () => '$$'));
}

function hostPathFor(source) {
  if (typeof source !== 'string' || /[\x00-\x1f\x7f]/.test(source)) {
    throw new Error('Choose folders with ordinary path characters.');
  }
  if (/^[A-Za-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/.test(source)) return win32;
  if (posix.isAbsolute(source)) return posix;
  throw new Error('Use an absolute path for each media folder.');
}

function sourceKey(source) {
  const hostPath = hostPathFor(source);
  const key = hostPath.normalize(source);
  return hostPath === win32 ? key.replace(/\\+$/, '').toLowerCase() : key.replace(/\/+$/, '');
}

const historyField = 'x-vidstream-folder-names: ';

function sourceHash(source) {
  return createHash('sha256').update(sourceKey(source)).digest('hex');
}

function folderHistory(compose) {
  const rows = compose.split(/\r?\n/).filter(line => line.startsWith(historyField));
  if (!rows.length) return {};
  if (rows.length !== 1) throw new Error('Duplicate VidStream folder history in Compose.');
  const history = JSON.parse(rows[0].slice(historyField.length).replace(/\$\$/g, () => '$'));
  if (!history || typeof history !== 'object' || Array.isArray(history) ||
      !Object.entries(history).every(([key, name]) => /^[a-f0-9]{64}$/.test(key) &&
        typeof name === 'string' && name && !name.startsWith('.') && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name)))
    throw new Error('The saved VidStream folder name history is invalid.');
  return history;
}

function mediaMounts(folders, existing = [], history = {}) {
  const sources = new Set(existing.map(mount => sourceKey(mount.source)));
  const names = new Set(existing.map(mount => posix.basename(mount.target).toLowerCase()));
  const reserved = new Set(Object.values(history).map(name => name.toLowerCase()));
  return folders.map(source => {
    const key = sourceKey(source);
    if (sources.has(key)) throw new Error('That media folder is already in the list.');
    sources.add(key);

    const folderName = hostPathFor(source).basename(source).replace(/^\.+/, '') || 'Media';
    const prior = history[sourceHash(source)];
    let name = prior || folderName;
    for (let suffix = 2; names.has(name.toLowerCase()) || (name !== prior && reserved.has(name.toLowerCase())); suffix++) name = `${folderName} (${suffix})`;
    names.add(name.toLowerCase());
    return { source, target: `${MEDIA_ROOT}/${name}` };
  });
}

function bindLines({ source, target }, primary = false) {
  return [
    '      - type: bind',
    `        source: ${yamlString(source)}`,
    `        target: ${primary ? '&primary_media ' : ''}${yamlString(target)}`,
    '        read_only: true',
    '        bind:',
    '          create_host_path: false',
  ];
}

function storageBind(name, target) {
  return [
    '      - type: bind',
    `        source: "./${PORTABLE_DIRECTORY}/${name}"`,
    `        target: "${target}"`,
    '        bind:',
    '          create_host_path: false',
  ];
}

function avoidStorageOverlap(source, directory) {
  if (!directory) return;
  const folders = hostPathFor(source);
  if (folders !== hostPathFor(directory)) return;
  const sourcePath = sourceKey(source) + folders.sep;
  const storagePath = sourceKey(directory) + folders.sep;
  if (sourcePath.startsWith(storagePath) || storagePath.startsWith(sourcePath))
    throw new Error('A media folder must be separate from the vidstream-local storage folder.');
}

function deploymentSettings({ port, memory = '2', swap = '0', bind = '127.0.0.1', host = '127.0.0.1' }) {
  const published = Number(port);
  if (!/^\d+$/.test(String(port)) || !Number.isInteger(published) || published < 1 || published > 65535) {
    throw new Error('Choose a port between 1 and 65535.');
  }
  if (![memory, swap].every(value => /^\d{1,5}$/.test(value)) || Number(memory) < 1) {
    throw new Error('Use a whole number of GiB for RAM and swap. RAM must be at least 1 GiB.');
  }
  if (!isIPv4(bind)) throw new Error('Choose an IPv4 bind address, such as 0.0.0.0 or the server’s LAN IP.');
  if (!isIPv4(host) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    throw new Error('Enter just the hostname or IPv4 address, such as subuntu.local.');
  }
  if (bind === '127.0.0.1' && host !== '127.0.0.1') {
    throw new Error('Local-only access uses 127.0.0.1.');
  }
  if (bind !== '127.0.0.1' && (host === 'localhost' || host.startsWith('127.') || host === '0.0.0.0')) {
    throw new Error('Use a LAN hostname or IP address as the browser address.');
  }
  const url = 'http://' + host + (published === 80 ? '' : ':' + published);
  return {
    memory: Number(memory), swap: Number(swap), bind, port: published, host, url,
    limit: Number(memory) + Number(swap), mapping: `${bind}:${published}:4000`,
  };
}

function createCompose({ image, port, theme = 'light-table', folders, storageDirectory, memory, swap, bind, host, role = 'server' }) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(image)) {
    throw new Error('Choose a valid Docker image reference.');
  }
  const deployment = deploymentSettings({ port, memory, swap, bind, host });
  if (role !== 'server' && role !== 'node') throw new Error('Choose server or node for the instance role.');
  if (!THEMES.has(theme)) throw new Error('Choose light-table, darkroom or system for the theme.');
  if (!Array.isArray(folders) || folders.length === 0) throw new Error('Choose at least one media folder.');
  if (role === 'node' && folders.length !== 1) throw new Error('Choose one media folder for a node.');

  for (const source of folders) avoidStorageOverlap(source, storageDirectory);
  const libraryMounts = mediaMounts(folders);
  const mounts = libraryMounts.flatMap((mount, index) => bindLines(mount, index === 0)).join('\n');
  const storage = [...STORAGE].flatMap(([name, target]) => storageBind(name, target)).join('\n');

  return `name: vidstream-starter
services:
  stream:
    image: ${yamlString(image)}
    restart: unless-stopped
    stop_grace_period: 5m
    security_opt:
      - no-new-privileges:true
    mem_limit: ${deployment.memory}g
    memswap_limit: ${deployment.limit}g
    ports:
      - ${yamlString(deployment.mapping)}
    volumes:
${storage}
${mounts}
    environment:
      PORT: "4000"
      HOST: "0.0.0.0"
      URL: ${yamlString(deployment.url)}
      MEDIA_DIR: ${MEDIA_ROOT}
      MEDIA_FOLDER_MODE: mounted
      MEDIA_FOLDER_ORDER: ${yamlString(JSON.stringify(libraryMounts.map(m => posix.basename(m.target))))}
      MEDIA_PRIMARY_MOUNT: *primary_media
      DATA_DIR: /app/data
      CACHE_DIR: /app/.cache
      ORIGINALS_DIR: /app/originals/original
      DEFAULT_THEME: ${yamlString(theme)}
      VIDSTREAM_ROLE: ${yamlString(role)}
      VIDSTREAM_SETUP_HELPER: "1"
`;
}

function section(lines, name, indent, bounds) {
  const [from, to] = bounds;
  const header = new RegExp(`^ {${indent}}${name}:[ \\t]*(?:#.*)?$`);
  for (let start = from; start < to; start++) {
    if (!header.test(lines[start].trimEnd())) continue;
    let end = start + 1;
    while (end < to) {
      const line = lines[end];
      if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break;
      end++;
    }
    return [start + 1, end];
  }
  throw new Error('Choose a Compose file created by the VidStream starter.');
}

function bindField(entry, key) {
  const prefix = `        ${key}:`;
  const field = entry.find(line => line.startsWith(prefix));
  const match = field?.slice(prefix.length).trim().match(/^(?:&[\w-]+\s+)?("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/);
  if (!match) throw new Error('Keep the starter’s quoted source and target fields when adding folders.');
  const value = JSON.parse(match[1]);
  if (value.replace(/\$\$/g, '').includes('$')) {
    throw new Error('Use literal paths in the starter’s media mounts.');
  }
  return value.replace(/\$\$/g, () => '$');
}

function starterDeploymentSections(lines) {
  const stream = section(lines, 'stream', 2, section(lines, 'services', 0, [0, lines.length]));
  const environment = section(lines, 'environment', 4, stream);
  if (!lines.slice(...environment).some(line => /^      VIDSTREAM_SETUP_HELPER:\s*(?:"1"|'1'|1)\s*(?:#.*)?$/.test(line))) {
    throw new Error('Choose the saved Compose file generated by Start-Here.');
  }
  return { stream, environment };
}

function simpleValue(lines, bounds, prefix) {
  const matches = [];
  for (let i = bounds[0]; i < bounds[1]; i++) {
    if (lines[i].startsWith(prefix)) matches.push(i);
  }
  if (matches.length !== 1) throw new Error('The saved Compose file uses custom deployment settings. Edit it directly.');
  const index = matches[0];
  const scalar = lines[index].slice(prefix.length).match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/);
  if (!scalar) throw new Error('The saved Compose file uses custom deployment settings. Edit it directly.');
  return { index, value: scalar[1] ?? scalar[2] ?? scalar[3] };
}

function inspectDeployment(compose) {
  const lines = compose.split(/\r?\n/);
  const { stream, environment } = starterDeploymentSections(lines);
  const ram = simpleValue(lines, stream, '    mem_limit:');
  const total = simpleValue(lines, stream, '    memswap_limit:');
  const ports = section(lines, 'ports', 4, stream);
  const mapping = simpleValue(lines, ports, '      - ');
  const url = simpleValue(lines, environment, '      URL:');
  const parsed = /^(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):4000$/.exec(mapping.value);
  const host = /^http:\/\/([a-z0-9.-]+)(?::(\d+))?\/?$/i.exec(url.value);
  function gib(size) {
    const value = /^(\d+)(g|m)(?:b)?$/i.exec(size);
    if (!value) return NaN;
    return Number(value[1]) / (value[2].toLowerCase() === 'm' ? 1024 : 1);
  }
  if (!parsed || !host || Number(host[2] || 80) !== Number(parsed[2]) ||
      lines.slice(...ports).filter(line => line.trim() && !line.trimStart().startsWith('#')).length !== 1) {
    throw new Error('The saved Compose file uses custom port mapping or HTTPS settings. Edit it directly.');
  }
  const bind = parsed[1] || '0.0.0.0';
  // A manual port change may have left the old loopback URL in place.
  const currentHost = bind === '127.0.0.1' ? bind : host[1].toLowerCase();
  const address = bind !== '127.0.0.1' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(currentHost)
    ? '127.0.0.1' : currentHost;
  const settings = deploymentSettings({ port: parsed[2], bind: address === '127.0.0.1' ? address : bind, host: address,
    memory: gib(ram.value), swap: gib(total.value) - gib(ram.value) });
  return { lines, ram, total, mapping, url, settings: { ...settings, bind } };
}

function configureCompose(compose, options) {
  const { lines, ram, total, mapping, url } = inspectDeployment(compose);
  const next = deploymentSettings(options);
  lines[ram.index] = `    mem_limit: ${next.memory}g`;
  lines[total.index] = `    memswap_limit: ${next.limit}g`;
  lines[mapping.index] = `      - ${yamlString(next.mapping)}`;
  lines[url.index] = `      URL: ${yamlString(next.url)}`;
  return lines.join(compose.includes('\r\n') ? '\r\n' : '\n');
}

function starterRole(compose) {
  const lines = compose.split(/\r?\n/);
  const { environment } = starterDeploymentSections(lines);
  return lines.slice(...environment).some(line => /^      VIDSTREAM_ROLE:\s*(?:node|"node"|'node')\s*(?:#.*)?$/.test(line)) ? 'node' : 'server';
}

function enableUpdater(compose) {
  const lines = compose.split(/\r?\n/);
  const { stream, environment } = starterDeploymentSections(lines);
  const volumes = section(lines, 'volumes', 4, stream);
  const mount = ['      - type: bind', '        source: "./.vidstream-updater"', '        target: "/app/updater"',
    '        bind:', '          create_host_path: false'];
  const mounts = lines.slice(...volumes);
  const targets = mounts.filter(line => /(?:target:\s*["']?|:)\/app\/updater(?:["':#\s]|$)/.test(line));
  const settings = lines.slice(...environment).filter(line => /^      VIDSTREAM_UPDATE_DIR:/.test(line));
  if (settings.length && (settings.length !== 1 || !/^      VIDSTREAM_UPDATE_DIR:\s*["']?\/app\/updater["']?\s*$/.test(settings[0])))
    throw new Error('Keep the updater directory at /app/updater.');
  if (targets.length && (targets.length !== 1 || !mounts.some((_, i) => mount.every((line, n) => mounts[i + n] === line))))
    throw new Error('The updater target already has a custom mount.');
  const insertions = [];
  if (!settings.length) insertions.push([environment[0], '      VIDSTREAM_UPDATE_DIR: /app/updater']);
  if (!targets.length) insertions.push([volumes[0], ...mount]);
  if (!insertions.length) return compose;
  for (const [at, ...entries] of insertions.sort((a, b) => b[0] - a[0])) lines.splice(at, 0, ...entries);
  return lines.join(compose.includes('\r\n') ? '\r\n' : '\n');
}

function addFolderToCompose(compose, source, storageDirectory, effectiveRole) {
  avoidStorageOverlap(source, storageDirectory);
  const lines = compose.split('\n');
  if (!lines.some(line => /^(name: vidstream-starter\s*$|# Generated by the VidStream starter\.)/.test(line))) {
    throw new Error('Choose a Compose file created by the VidStream starter.');
  }
  const services = section(lines, 'services', 0, [0, lines.length]);
  const stream = section(lines, 'stream', 2, services);
  const [envStart, envEnd] = section(lines, 'environment', 4, stream);
  const settings = lines.slice(envStart, envEnd).map(line => line.trim());
  if (!settings.includes(`MEDIA_DIR: ${MEDIA_ROOT}`) || !settings.includes('MEDIA_FOLDER_MODE: mounted')) {
    throw new Error('This Compose file does not use the starter’s mounted-folder layout.');
  }
  if ((effectiveRole || starterRole(compose)) === 'node') {
    throw new Error('A node cannot add a library. Change this instance to Server in VidStream before adding a folder.');
  }

  const [start, end] = section(lines, 'volumes', 4, stream);
  const entries = [];
  for (const line of lines.slice(start, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('      - ')) entries.push([line]);
    else if (entries.length && line.startsWith('        ')) entries.at(-1).push(line);
    else throw new Error('The starter’s media mount list has an unsupported layout.');
  }
  const existing = [];
  for (const entry of entries) {
    if (!/^\s*- type: bind\s*(?:#.*)?$/.test(entry[0].trimEnd())) {
      if (entry.some(line => line.includes(MEDIA_ROOT))) {
        throw new Error('Use the starter’s long bind syntax for all media mounts.');
      }
      continue;
    }
    const target = bindField(entry, 'target');
    if (target === MEDIA_ROOT || (target.startsWith(MEDIA_ROOT + '/') && posix.dirname(target) !== MEDIA_ROOT)) {
      throw new Error('Use one mount per folder directly under the media root.');
    }
    if (posix.dirname(target) === MEDIA_ROOT) existing.push({ source: bindField(entry, 'source'), target });
  }
  if (!existing.length) throw new Error('Keep at least one starter media mount before adding another.');

  const [mount] = mediaMounts([source], existing, folderHistory(compose));
  let insertion = end;
  while (insertion > start && (!lines[insertion - 1].trim() || lines[insertion - 1].trimStart().startsWith('#'))) insertion--;
  const suffix = lines[insertion - 1].endsWith('\r') ? '\r' : '';
  lines.splice(insertion, 0, ...bindLines(mount).map(line => line + suffix));
  return lines.join('\n');
}

function storageStatus(compose) {
  const lines = compose.split(/\r?\n/);
  const services = section(lines, 'services', 0, [0, lines.length]);
  const stream = section(lines, 'stream', 2, services);
  const [envStart, envEnd] = section(lines, 'environment', 4, stream);
  if (!lines.slice(envStart, envEnd).some(line => line.trim() === 'VIDSTREAM_SETUP_HELPER: "1"')) {
    throw new Error('Choose the saved Compose file generated by Start-Here.');
  }
  const [start, end] = section(lines, 'volumes', 4, stream);
  const media = lines.slice(start, end);
  const legacy = [];
  for (const [name, target] of STORAGE) {
    const old = '      - stream-' + name + ':' + target;
    const oldIndexes = media.flatMap((line, index) => line.trimEnd() === old ? [index + start] : []);
    const bind = storageBind(name, target);
    const portable = media.filter((line, offset) => bind.every((field, index) =>
      media[offset + index]?.trimEnd() === field)).length;
    if (oldIndexes.length + portable !== 1) {
      throw new Error('Customize or migrate this installation manually. Its storage mounts differ from the starter layout.');
    }
    if (oldIndexes.length) legacy.push({ index: oldIndexes[0], bind });
  }
  if (legacy.length && legacy.length !== STORAGE.size) {
    throw new Error('This installation mixes storage layouts. It needs a manual migration.');
  }
  return { lines, stream, legacy, kind: legacy.length ? 'legacy' : 'portable' };
}

function guidedMedia(compose) {
  const lines = compose.split(/\r?\n/);
  const { stream, environment } = starterDeploymentSections(lines);
  if (!lines.slice(...environment).some(line => line.trim() === 'MEDIA_PRIMARY_MOUNT: *primary_media')) {
    throw new Error('This Compose file uses a custom primary folder. Edit it on the host.');
  }
  const [start, end] = section(lines, 'volumes', 4, stream);
  const mounts = [];
  for (let index = start; index < end;) {
    if (!lines[index].startsWith('      - ')) { index++; continue; }
    let next = index + 1;
    while (next < end && !lines[next].startsWith('      - ')) next++;
    const entry = lines.slice(index, next);
    if (entry.some(line => !line.trimStart().startsWith('#') && line.includes(MEDIA_ROOT))) {
      const target = bindField(entry, 'target');
      if (posix.dirname(target) === MEDIA_ROOT) {
        const source = bindField(entry, 'source');
        const primary = entry.some(line => /^        target:\s*&primary_media\s/.test(line));
        if (!/^      - type: bind\s*$/.test(entry[0]) ||
            !entry.some(line => /^        read_only:\s*true\s*(?:#.*)?$/.test(line))) {
          throw new Error('The web picker can edit read-only long-form media mounts. Keep custom mounts in your own Compose file.');
        }
        let stop = next;
        while (stop > index && (!lines[stop-1].trim() || lines[stop-1].trimStart().startsWith('#'))) stop--;
        mounts.push({ source, target, primary, start: index, end: stop, lines: lines.slice(index, stop) });
      } else if (target === MEDIA_ROOT || target.startsWith(MEDIA_ROOT + '/')) {
        throw new Error('Keep each top-level library mounted directly under /media/collections.');
      }
    }
    index = next;
  }
  if (mounts.filter(m => m.primary).length !== 1 || new Set(mounts.map(m => sourceKey(m.source))).size !== mounts.length ||
      new Set(mounts.map(m => m.target.toLowerCase())).size !== mounts.length) {
    throw new Error('The web picker requires unique library mounts and one primary folder.');
  }
  return { lines, mounts };
}

function inspectGuided(compose) {
  const { mounts } = guidedMedia(compose);
  return {
    folders: [...mounts].sort((a,b) => Number(b.primary) - Number(a.primary))
      .map(m => ({ path: m.source, name: posix.basename(m.target) })),
    deployment: inspectDeployment(compose).settings,
    storage: storageStatus(compose).kind,
    role: starterRole(compose),
  };
}

function editGuided({ compose, folders, deployment, storageDirectory, role }) {
  if (!Array.isArray(folders) || folders.length < 1 || folders.length > 256 ||
      new Set(folders.map(sourceKey)).size !== folders.length) throw new Error('Choose 1–256 distinct media folders.');
  const { lines, mounts } = guidedMedia(compose);
  const existing = new Map(mounts.map(m => [sourceKey(m.source), m]));
  const history = folderHistory(compose);
  for (const mount of mounts) history[sourceHash(mount.source)] = posix.basename(mount.target);
  if ((role || starterRole(compose)) === 'node' && folders.length > 1 && folders.some(f => !existing.has(sourceKey(f)))) {
    throw new Error('Switch to Server to add multiple libraries.');
  }
  const replacements = [];
  const order = [];
  const assigned = [...mounts];
  for (const [index, folder] of folders.entries()) {
    avoidStorageOverlap(folder, storageDirectory);
    let mount = existing.get(sourceKey(folder));
    if (!mount) {
      [mount] = mediaMounts([folder], assigned, history);
      assigned.push(mount);
    }
    order.push(posix.basename(mount.target));
    if (mount.lines) {
      replacements.push(...mount.lines.map(line => /^        target:/.test(line) ?
        line.replace(/^(        target:\s*)(?:&primary_media\s+)?/, (_, prefix) => prefix + (index ? '' : '&primary_media ')) : line));
    } else {
      replacements.push(...bindLines(mount, index === 0));
    }
  }
  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    lines.splice(mount.start, mount.end - mount.start, ...(i === 0 ? replacements : []));
  }
  const { environment } = starterDeploymentSections(lines);
  const setting = '      MEDIA_FOLDER_ORDER: ' + yamlString(JSON.stringify(order));
  const matches = lines.slice(...environment).map((line, i) => line.startsWith('      MEDIA_FOLDER_ORDER:') ? environment[0] + i : -1).filter(i => i >= 0);
  if (matches.length > 1) throw new Error('The Compose file contains duplicate folder orders.');
  if (matches.length) lines[matches[0]] = setting;
  else lines.splice(environment[0], 0, setting);
  const record = historyField + JSON.stringify(history).replace(/\$/g, () => '$$');
  const extension = lines.findIndex(line => line.startsWith(historyField));
  if (extension >= 0) lines[extension] = record;
  else lines.unshift(record);
  return configureCompose(lines.join(compose.includes('\r\n') ? '\r\n' : '\n'), deployment);
}

function makePortable(compose) {
  const { lines, stream, legacy } = storageStatus(compose);
  if (!legacy.length) return compose;
  for (const { index, bind } of legacy.reverse()) lines.splice(index, 1, ...bind);
  if (!lines.slice(...stream).some(line => /^    stop_grace_period:/.test(line))) {
    lines.splice(stream[0], 0, '    stop_grace_period: 5m');
  }
  const [start, end] = section(lines, 'volumes', 0, [0, lines.length]);
  const volumes = lines.slice(start, end);
  const expected = new Set([...STORAGE.keys()].map(name => '  stream-' + name + ':'));
  const defaults = volumes.filter(line => line.trim() && !line.trimStart().startsWith('#'));
  if (defaults.length === expected.size && defaults.every(line => expected.delete(line.trimEnd()))) {
    lines.splice(start - 1, end - start + 1, '');
  }
  return lines.join(compose.includes('\r\n') ? '\r\n' : '\n');
}

function verifyLegacyVolumes(model, storageDirectory) {
  if (model.name !== 'vidstream-starter' || !model.services?.stream)
    throw new Error('Compose does not identify the guided VidStream project.');
  const mounts = model.services.stream.volumes || [];
  if (storageDirectory) for (const mount of mounts) {
    if (mount.type === 'bind' && mount.target.startsWith(MEDIA_ROOT + '/'))
      avoidStorageOverlap(mount.source, storageDirectory);
  }
  const names = [];
  for (const [name, target] of STORAGE) {
    const source = 'stream-' + name;
    const expected = model.name + '_' + source;
    const match = mounts.filter(mount => mount.target === target);
    if (match.length !== 1 || match[0].type !== 'volume' || match[0].source !== source ||
        model.volumes?.[source]?.name !== expected || model.volumes[source].external) {
      throw new Error('This installation uses custom storage. Copy it manually.');
    }
    names.push(expected);
  }
  return names.join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--host-inspect') {
      process.stdout.write(JSON.stringify(inspectGuided(fs.readFileSync(0, 'utf8'))));
    } else if (args[0] === '--host-edit') {
      process.stdout.write(editGuided(JSON.parse(fs.readFileSync(0, 'utf8'))));
    } else if (args[0] === '--add-folder') {
      if (args.length < 2 || args.length > 4 || (args[3] && !['server', 'node'].includes(args[3]))) {
        throw new Error('Choose one folder to add.');
      }
      process.stdout.write(addFolderToCompose(fs.readFileSync(0, 'utf8'), args[1], args[2], args[3]));
    } else if (args[0] === '--role') {
      process.stdout.write(starterRole(fs.readFileSync(0, 'utf8')) + '\n');
    } else if (args[0] === '--enable-updater') {
      process.stdout.write(enableUpdater(fs.readFileSync(0, 'utf8')));
    } else if (args[0] === '--deployment-summary') {
      const { memory, swap, bind, host, port } = inspectDeployment(fs.readFileSync(0, 'utf8')).settings;
      process.stdout.write([memory, swap, bind, host, port].join('\n') + '\n');
    } else if (args[0] === '--configure') {
      if (args.length !== 6) throw new Error('Choose RAM, swap, bind address, hostname, and port.');
      const [, memory, swap, bind, host, port] = args;
      process.stdout.write(configureCompose(fs.readFileSync(0, 'utf8'), { memory, swap, bind, host, port }));
    } else if (args[0] === '--storage-status') {
      process.stdout.write(storageStatus(fs.readFileSync(0, 'utf8')).kind + '\n');
    } else if (args[0] === '--portable') {
      process.stdout.write(makePortable(fs.readFileSync(0, 'utf8')));
    } else if (args[0] === '--legacy-volume-names') {
      process.stdout.write(verifyLegacyVolumes(JSON.parse(fs.readFileSync(0, 'utf8')), args[1]));
    } else {
      const storageDirectory = args[0] === '--storage-dir' ? args.splice(0, 2)[1] : undefined;
      const [memory, swap, bind, host, role] = args[0] === '--deployment' ? args.splice(0, 6).slice(1) : [];
      const [image, port, theme, separator, ...folders] = args;
      if (separator !== '--') throw new Error('Expected the media folder paths after --.');
      process.stdout.write(createCompose({ image, port, theme, folders, storageDirectory, memory, swap, bind, host, role }));
    }
  } catch (error) {
    console.error(`VidStream setup: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createCompose, addFolderToCompose, configureCompose, makePortable, storageStatus, verifyLegacyVolumes, enableUpdater };
