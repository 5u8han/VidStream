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
const { PlaybackService } = require('../lib/playback-service');
const { Maintenance } = require('../lib/maintenance');
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
  return { root, cfg, db, item, source, maintenance: new Maintenance(cfg, db) };
}

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
    assert.ok(space.dataBytes > 0);
    assert.equal(Object.hasOwn(space, 'outputBytes'), false);
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
