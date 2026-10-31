'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Db } = require('../lib/db');
const { policyFor, estimate, jobMatches } = require('../lib/media-policy');
const { optionsFor } = require('../lib/enhancement-queue');
const { VariantService } = require('../lib/variant-service');
const { PlaybackService } = require('../lib/playback-service');
const { Maintenance } = require('../lib/maintenance');
const { publicItem } = require('../lib/serialize');
const hasTools = spawnSync('ffmpeg', ['-version']).status === 0;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('Timed out waiting for playback preparation');
}
function fixture(t, extension = '.mp4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-workbench-'));
  const cfg = {
    mediaDir: path.join(root, 'media'),
    cacheDir: path.join(root, 'cache'),
    dataDir: path.join(root, 'data'),
    originalsDir: path.join(root, 'originals', 'original')
  };
  fs.mkdirSync(cfg.mediaDir);
  const db = new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir);
  t.after(() => {
    clearTimeout(db._saveTimer);
    db.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(cfg.mediaDir, 'clip' + extension);
  execFileSync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '0.6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    source,
    '-loglevel',
    'error'
  ]);
  const stat = fs.statSync(source),
    sourceHash = hash(source),
    item = {
      id: 'clip',
      relPath: 'clip' + extension,
      filename: 'clip' + extension,
      ext: extension,
      type: 'video',
      width: 64,
      height: 48,
      duration: 0.6,
      hasAudio: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      fingerprint: stat.mtimeMs + ':' + stat.size + ':recipe',
      sourceHash,
      sourceVersion: sourceHash,
      tech: {
        videoCodec: 'h264',
        audioCodec: 'aac',
        frameRate: 24,
        pixelFormat: 'yuv420p',
        bitDepth: 8
      }
    };
  db.upsert(item);
  db.store.update(item, { favorite: true, pinned: true });
  const queue = {
    dir: (id) => path.join(cfg.dataDir, 'enhancements', id),
    get: (id) => db.store.job(id),
    save: (job) => db.store.saveJob(job)
  };
  const id = crypto.randomUUID(),
    directory = queue.dir(id);
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'enhanced.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-i',
    source,
    '-vf',
    'fps=60',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-t',
    '0.6',
    output,
    '-loglevel',
    'error'
  ]);
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'quiet', '-show_streams', '-show_format', '-of', 'json', output],
      { encoding: 'utf8' }
    )
  );
  const video = metadata.streams.find((stream) => stream.codec_type === 'video');
  const job = {
    id,
    itemId: item.id,
    mediaId: item.mediaId,
    relPath: item.relPath,
    filename: item.filename,
    state: 'completed',
    sourceHash,
    sourceVersion: sourceHash,
    sourceFingerprint: item.fingerprint,
    outputHash: hash(output),
    options: { fps: 60, smoothing: 'ffmpeg', upscale: 'none' },
    verification: {
      duration: Number(metadata.format.duration),
      frames: Number(video.nb_frames),
      width: video.width,
      height: video.height,
      audioTracks: metadata.streams.filter((s) => s.codec_type === 'audio').length
    },
    completedAt: new Date().toISOString()
  };
  queue.save(job);
  const scanner = { scanning: false, editing: false };
  return {
    root,
    cfg,
    db,
    item,
    source,
    output,
    job,
    queue,
    scanner,
    variants: new VariantService(cfg, db, queue, scanner),
    maintenance: new Maintenance(cfg, db, queue)
  };
}

test('enhancement policy explicitly rejects HDR/high-depth processing and bounds sample ranges', () => {
  const input = {
    type: 'video',
    duration: 30,
    width: 1280,
    height: 720,
    size: 1024,
    tech: { frameRate: 24, colorTransfer: 'smpte2084' }
  };
  assert.equal(policyFor(input).supported, false);
  assert.throws(() => optionsFor({}, input), /HDR/);
  assert.equal(policyFor({ ...input, tech: { pixelFormat: 'yuv420p10le' } }).supported, false);
  const sdr = { ...input, tech: { frameRate: 24 } };
  for (const spec of [
    { preview: true, start: -1, end: 3 },
    { preview: true, start: 0, end: 16 },
    { preview: true, start: 25, end: 31 }
  ])
    assert.throws(() => optionsFor(spec, sdr), /sample range/);
  const spec = optionsFor({ preview: true, start: 4, end: 9, smoothing: 'ffmpeg' }, sdr),
    value = estimate(sdr, spec);
  assert.equal(value.seconds, 5);
  assert.equal(value.frames, 300);
  assert.ok(value.workingBytes > sdr.size);
  assert.match(policyFor(sdr).conversions.join(' '), /AAC/);
});

test('legacy source recipe changes still match the same bytes under the catalog version contract', () => {
  assert.equal(
    jobMatches(
      { sourceFingerprint: '1000:123:old-recipe' },
      { sourceVersion: 'stat:1000:123', fingerprint: '1000:123:new-recipe' }
    ),
    true
  );
});

test(
  'approval and publication preserve identity/preferences and restore verified originals outside media',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      original = fs.readFileSync(f.source),
      mediaId = f.item.mediaId;
    await f.variants.activate(f.item, f.job.id);
    assert.equal(f.item.activeVariant, f.job.id);
    assert.equal(f.item.favorite, true);
    const cfg = { ...f.cfg, thumbnailSizes: [320], posterSizes: [320], largeSizes: [1280] };
    assert.match(publicItem(f.item, cfg, true).urls.full, /\/enhancements\//);
    const result = await f.variants.publish(f.item, f.job.id);
    assert.ok(result.archive.startsWith(fs.realpathSync(f.cfg.originalsDir) + path.sep));
    assert.equal(result.archive.startsWith(fs.realpathSync(f.cfg.mediaDir) + path.sep), false);
    assert.deepEqual(fs.readFileSync(result.archive), original);
    assert.equal(hash(f.source), f.job.outputHash);
    assert.equal(f.item.mediaId, mediaId);
    assert.equal(f.item.favorite, true);
    assert.equal(f.item.activeVariant, null);
    assert.equal(
      f.item.tech.frameRate,
      60,
      'Published source metadata should describe the new active file'
    );
    assert.equal(await f.variants.restore(f.item).then((v) => v.restored), true);
    assert.deepEqual(fs.readFileSync(f.source), original);
    assert.equal(f.item.mediaId, mediaId);
    assert.equal(f.item.favorite, true);
    assert.equal(f.item.tech.frameRate, 24);
    const restoredStat = fs.statSync(f.source);
    assert.equal(f.item.size, restoredStat.size);
    assert.equal(f.item.mtime, restoredStat.mtime.toISOString());
    assert.equal(f.item.processing.previewReady, false);
    assert.equal(f.item.processing.stage, 'pending');
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(path.dirname(result.archive), 'publication.json'), 'utf8')
      ).state,
      'restored'
    );
  }
);

test(
  'publication refuses destination collisions and stale source bytes without overwriting',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t, '.mov');
    const collision = path.join(f.cfg.mediaDir, 'clip.mp4');
    fs.writeFileSync(collision, 'unrelated');
    await assert.rejects(f.variants.publish(f.item, f.job.id), /destination name/);
    assert.equal(fs.readFileSync(collision, 'utf8'), 'unrelated');
    fs.writeFileSync(f.source, 'changed-source');
    await assert.rejects(f.variants.publish(f.item, f.job.id), /Source bytes changed/);
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'changed-source');
    assert.equal(f.scanner.editing, false);
  }
);

test(
  'MOV publication and restore retain one catalog identity across extension changes',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t, '.mov'),
      identity = f.item.mediaId,
      sourceBytes = fs.readFileSync(f.source);
    const published = await f.variants.publish(f.item, f.job.id);
    assert.equal(f.item.relPath, 'clip.mp4');
    assert.equal(fs.existsSync(f.source), false);
    assert.equal(f.db.count(), 1);
    assert.equal(f.item.mediaId, identity);
    await f.variants.restore(f.item);
    assert.equal(f.item.relPath, 'clip.mov');
    assert.deepEqual(fs.readFileSync(f.source), sourceBytes);
    assert.equal(f.item.mediaId, identity);
    assert.equal(f.item.pinned, true);
    assert.ok(fs.existsSync(published.archive));
  }
);

test(
  'corrupt completed output cannot become the active version or replace a source',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      before = hash(f.source);
    fs.writeFileSync(f.output, 'corrupt output');
    await assert.rejects(f.variants.activate(f.item, f.job.id), /verification/);
    await assert.rejects(f.variants.publish(f.item, f.job.id), /verification/);
    assert.equal(f.item.activeVariant, undefined);
    assert.equal(hash(f.source), before);
    assert.equal(f.item.favorite, true);
  }
);

test(
  'maintenance backup is a consistent SQLite snapshot and retention keeps cumulative counts',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      event = {
        id: crypto.randomUUID(),
        visitor: 'viewer',
        action: 'open',
        at: '2020-01-01',
        details: {}
      };
    f.db.store.track(f.item, event);
    f.db.store.track(f.item, {
      ...event,
      id: crypto.randomUUID(),
      action: 'watch',
      details: { seconds: 12, position: 0.3 }
    });
    const backup = await f.maintenance.backup(),
      copy = new DatabaseSync(backup.file, { readOnly: true });
    assert.equal(copy.prepare('SELECT count(*) AS count FROM catalog').get().count, 1);
    assert.equal(copy.prepare('SELECT count(*) AS count FROM activity').get().count, 2);
    copy.close();
    const pruned = f.maintenance.pruneActivity(30);
    assert.equal(pruned.removed, 2);
    assert.equal(f.db.store.activityStats(f.item).opens, 1);
    assert.equal(f.db.store.activityStats(f.item).watch_seconds, 12);
    assert.equal(f.db.store.activityStats(f.item).position, 0.3);
    const space = await f.maintenance.storage();
    assert.ok(space.outputBytes > 0);
    assert.ok(space.freeBytes > 0);
    assert.ok(space.originalMediaBytes > 0);
  }
);

test(
  'compatible playback remuxes and reuses a verified local MP4 without mutating its source',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      before = hash(f.source),
      service = new PlaybackService(f.cfg, f.db, null);
    const job = await service.prepare(f.item);
    await until(() => ['completed', 'failed'].includes(job.state));
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.mode, 'remux / audio adaptation');
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'quiet', '-show_streams', '-of', 'json', service.file(f.item)],
        { encoding: 'utf8' }
      )
    );
    assert.equal(probe.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
    assert.equal((await service.prepare(f.item)).state, 'completed');
    assert.equal(hash(f.source), before);
    assert.equal(
      fs.readdirSync(path.dirname(service.file(f.item))).filter((n) => n.endsWith('.mp4')).length,
      1
    );
  }
);

test(
  'playback preparation can retry after a temporary source outage',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      service = new PlaybackService(f.cfg, f.db, null);
    fs.renameSync(f.source, f.source + '.offline');
    const failed = await service.prepare(f.item);
    await until(() => failed.state === 'failed');
    fs.renameSync(f.source + '.offline', f.source);
    const retried = await service.prepare(f.item);
    await until(() => ['completed', 'failed'].includes(retried.state));
    assert.equal(retried.state, 'completed', retried.error);
  }
);

function pendingPublication(f, state = 'published') {
  const id = crypto.randomUUID(),
    dir = path.join(f.cfg.originalsDir, f.item.mediaId, id);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, 'original.mp4');
  fs.copyFileSync(f.source, archive);
  const record = {
    id,
    mediaId: f.item.mediaId,
    jobId: f.job.id,
    source: f.item.relPath,
    target: f.item.relPath,
    originalHash: f.job.sourceHash,
    outputHash: f.job.outputHash,
    state,
    item: { ...f.item },
    archive
  };
  fs.writeFileSync(path.join(dir, 'publication.json'), JSON.stringify(record));
  return { dir, archive, record };
}

test(
  'manual recovery restores a verified original after publication lost its database link',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      pending = pendingPublication(f),
      before = fs.readFileSync(f.source);
    fs.copyFileSync(f.output, f.source);
    assert.equal(f.item.lastPublication, undefined);
    const result = await f.variants.recoverPending();
    assert.equal(result.recovered, 1);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(fs.readFileSync(f.source), before);
    assert.equal(f.item.favorite, true);
    assert.equal(f.item.mediaId, pending.record.mediaId);
    assert.equal(f.item.size, fs.statSync(f.source).size);
    assert.equal(f.item.mtime, fs.statSync(f.source).mtime.toISOString());
    assert.equal(f.item.processing.previewReady, false);
    const journal = JSON.parse(fs.readFileSync(path.join(pending.dir, 'publication.json'), 'utf8'));
    assert.equal(['prepared', 'published', 'restoring'].includes(journal.state), false);
    assert.equal((await f.variants.recoverPending()).recovered, 0, 'Recovery is idempotent');
  }
);

test(
  'recovery handles prepared operations without replacing intact originals and refuses changed targets',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      pending = pendingPublication(f, 'prepared'),
      before = hash(f.source);
    const prepared = await f.variants.recoverPending();
    assert.equal(prepared.recovered, 1);
    assert.equal(hash(f.source), before);
    const again = pendingPublication(f);
    fs.writeFileSync(f.source, 'external edit');
    const blocked = await f.variants.recoverPending();
    assert.equal(blocked.recovered, 0);
    assert.equal(blocked.issues.length, 1);
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'external edit');
    assert.equal(hash(again.archive), f.job.sourceHash);
    assert.ok(fs.existsSync(pending.archive));
  }
);

test(
  'symlinked original archive inside the media library is rejected',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      link = path.join(f.root, 'archive-link');
    fs.symlinkSync(f.cfg.mediaDir, link, 'dir');
    f.cfg.originalsDir = link;
    await assert.rejects(f.variants.publish(f.item, f.job.id), /outside|archive/i);
    assert.equal(hash(f.source), f.job.sourceHash);
  }
);

test(
  'recovery reuses a verified interrupted temporary copy and retains corrupt copies for review',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      pending = pendingPublication(f),
      before = fs.readFileSync(f.source);
    fs.copyFileSync(f.output, f.source);
    const temp = path.join(f.cfg.mediaDir, '.vidstream-recover-' + pending.record.id + '.mp4');
    fs.copyFileSync(pending.archive, temp);
    const result = await f.variants.recoverPending();
    assert.equal(result.recovered, 1);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(fs.readFileSync(f.source), before);
    assert.equal(fs.existsSync(temp), false);
    const second = pendingPublication(f);
    fs.copyFileSync(f.output, f.source);
    const corrupt = path.join(f.cfg.mediaDir, '.vidstream-recover-' + second.record.id + '.mp4');
    fs.writeFileSync(corrupt, 'incomplete copy');
    const blocked = await f.variants.recoverPending();
    assert.equal(blocked.recovered, 0);
    assert.match(blocked.issues[0].error, /unverified temporary/);
    assert.equal(hash(f.source), f.job.outputHash);
    assert.equal(fs.readFileSync(corrupt, 'utf8'), 'incomplete copy');
    assert.equal(hash(second.archive), f.job.sourceHash);
  }
);

test(
  'interrupted extension-changing publication recovers one original and preserves its catalog identity',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t, '.mov'),
      pending = pendingPublication(f),
      before = fs.readFileSync(f.source),
      target = path.join(f.cfg.mediaDir, 'clip.mp4');
    pending.record.target = 'clip.mp4';
    fs.writeFileSync(path.join(pending.dir, 'publication.json'), JSON.stringify(pending.record));
    fs.copyFileSync(f.output, target);
    fs.unlinkSync(f.source);
    f.db.relocate(f.item, 'clip.mp4');
    const result = await f.variants.recoverPending();
    assert.equal(result.recovered, 1);
    assert.deepEqual(result.issues, []);
    assert.equal(f.item.relPath, 'clip.mov');
    assert.equal(f.db.count(), 1);
    assert.equal(f.item.mediaId, pending.record.mediaId);
    assert.deepEqual(fs.readFileSync(f.source), before);
    assert.equal(fs.existsSync(target), false);
    assert.equal(f.item.size, before.length);
  }
);

test(
  'publication and recovery refuse parent-directory symlinks escaping the library',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.copyFileSync(f.source, path.join(outside, 'clip.mp4'));
    fs.symlinkSync(outside, path.join(f.cfg.mediaDir, 'redirect'), 'dir');
    f.db.relocate(f.item, 'redirect/clip.mp4');
    const before = hash(path.join(outside, 'clip.mp4'));
    await assert.rejects(f.variants.publish(f.item, f.job.id), /outside/);
    assert.equal(hash(path.join(outside, 'clip.mp4')), before);
    const pending = pendingPublication(f);
    fs.copyFileSync(f.output, path.join(outside, 'clip.mp4'));
    const result = await f.variants.recoverPending();
    assert.equal(result.recovered, 0);
    assert.match(result.issues[0].error, /outside/);
    assert.equal(hash(path.join(outside, 'clip.mp4')), f.job.outputHash);
    assert.ok(fs.existsSync(pending.archive));
  }
);

test(
  'restore refuses a newly occupied original destination including dangling symlinks',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t, '.mov');
    await f.variants.publish(f.item, f.job.id);
    const published = path.join(f.cfg.mediaDir, 'clip.mp4');
    fs.symlinkSync(path.join(f.root, 'absent'), f.source);
    await assert.rejects(f.variants.restore(f.item), /symbolic-link/);
    assert.ok(fs.lstatSync(f.source).isSymbolicLink());
    assert.equal(hash(published), f.job.outputHash);
  }
);

test(
  'publication takes its exclusive lock before asynchronous verification',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t);
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      completed = f.variants.completed.bind(f.variants);
    f.variants.completed = async (...args) => {
      await gate;
      return completed(...args);
    };
    const first = f.variants.publish(f.item, f.job.id);
    await assert.rejects(f.variants.publish(f.item, f.job.id), /Wait for/);
    release();
    await first;
    assert.equal(hash(f.source), f.job.outputHash);
    assert.equal(f.scanner.editing, false);
  }
);
