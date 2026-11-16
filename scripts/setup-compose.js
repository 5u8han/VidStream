'use strict';
const fs = require('node:fs');
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

function mediaMounts(folders, existing = []) {
  const sources = new Set(existing.map(mount => sourceKey(mount.source)));
  const names = new Set(existing.map(mount => posix.basename(mount.target).toLowerCase()));
  return folders.map(source => {
    const key = sourceKey(source);
    if (sources.has(key)) throw new Error('That media folder is already in the list.');
    sources.add(key);

    const folderName = hostPathFor(source).basename(source).replace(/^\.+/, '') || 'Media';
    let name = folderName;
    for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${folderName} (${suffix})`;
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

function createCompose({ image, port, theme = 'light-table', folders, storageDirectory }) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(image)) {
    throw new Error('Choose a valid Docker image reference.');
  }
  const published = Number(port);
  if (!/^\d+$/.test(String(port)) || !Number.isInteger(published) || published < 1 || published > 65535) {
    throw new Error('Choose a port between 1 and 65535.');
  }
  if (!THEMES.has(theme)) throw new Error('Choose light-table, darkroom or system for the theme.');
  if (!Array.isArray(folders) || folders.length === 0) throw new Error('Choose at least one media folder.');

  for (const source of folders) avoidStorageOverlap(source, storageDirectory);
  const mounts = mediaMounts(folders).flatMap((mount, index) => bindLines(mount, index === 0)).join('\n');
  const url = 'http://127.0.0.1' + (published === 80 ? '' : ':' + published);
  const storage = [...STORAGE].flatMap(([name, target]) => storageBind(name, target)).join('\n');

  return `name: vidstream-starter
services:
  stream:
    image: ${yamlString(image)}
    restart: unless-stopped
    stop_grace_period: 5m
    security_opt:
      - no-new-privileges:true
    mem_limit: 2g
    memswap_limit: 2g
    ports:
      - "127.0.0.1:${published}:4000"
    volumes:
${storage}
${mounts}
    environment:
      PORT: "4000"
      HOST: "0.0.0.0"
      URL: ${yamlString(url)}
      MEDIA_DIR: ${MEDIA_ROOT}
      MEDIA_FOLDER_MODE: mounted
      MEDIA_PRIMARY_MOUNT: *primary_media
      DATA_DIR: /app/data
      CACHE_DIR: /app/.cache
      ORIGINALS_DIR: /app/originals/original
      DEFAULT_THEME: ${yamlString(theme)}
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

function addFolderToCompose(compose, source, storageDirectory) {
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

  const [mount] = mediaMounts([source], existing);
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
    if (args[0] === '--add-folder') {
      if (args.length < 2 || args.length > 3) throw new Error('Choose one folder to add.');
      process.stdout.write(addFolderToCompose(fs.readFileSync(0, 'utf8'), args[1], args[2]));
    } else if (args[0] === '--storage-status') {
      process.stdout.write(storageStatus(fs.readFileSync(0, 'utf8')).kind + '\n');
    } else if (args[0] === '--portable') {
      process.stdout.write(makePortable(fs.readFileSync(0, 'utf8')));
    } else if (args[0] === '--legacy-volume-names') {
      process.stdout.write(verifyLegacyVolumes(JSON.parse(fs.readFileSync(0, 'utf8')), args[1]));
    } else {
      const storageDirectory = args[0] === '--storage-dir' ? args.splice(0, 2)[1] : undefined;
      const [image, port, theme, separator, ...folders] = args;
      if (separator !== '--') throw new Error('Expected the media folder paths after --.');
      process.stdout.write(createCompose({ image, port, theme, folders, storageDirectory }));
    }
  } catch (error) {
    console.error(`VidStream setup: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createCompose, addFolderToCompose, makePortable, storageStatus, verifyLegacyVolumes };
