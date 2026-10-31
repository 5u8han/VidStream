'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { Db } = require('../lib/db');
const { EnhancementQueue, optionsFor } = require('../lib/enhancement-queue');
const { policyFor, estimate } = require('../lib/media-policy');
const { run } = require('../lib/exec');

const hasTools = spawnSync('ffmpeg', ['-version']).status === 0;
const ffmpegHelp = hasTools
  ? String(spawnSync('ffmpeg', ['-h', 'full'], { maxBuffer: 4 * 1024 * 1024 }).stdout)
  : '';
const hasDisplayRotation = ffmpegHelp.includes('-display_rotation');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled(queue, id) {
  for (let i = 0; i < 3000; i++) {
    const job = queue.get(id);
    if (!queue.active && ['completed', 'paused', 'cancelled'].includes(job.state)) return job;
    await delay(10);
  }
  throw Error('Enhancement did not settle');
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-enhancement-review-'));
  const cfg = { mediaDir: path.join(root, 'media'), dataDir: path.join(root, 'data') };
  fs.mkdirSync(cfg.mediaDir);
  const db = new Db(path.join(root, 'cache', 'index.json'), cfg.dataDir);
  const queue = new EnhancementQueue(cfg, db, options);
  t.after(async () => {
    await queue.stop();
    clearTimeout(db._saveTimer);
    db.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { cfg, db, queue };
}
function clip(cfg, duration = 8) {
  const file = path.join(cfg.mediaDir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=24',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(t\\,2)\\,sin(2*PI*220*t)\\,sin(2*PI*880*t)):s=48000',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1100:sample_rate=48000',
    '-t',
    String(duration),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-metadata',
    'title=Preservation test',
    file,
    '-loglevel',
    'error'
  ]);
  return {
    id: 'clip',
    relPath: 'clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    width: 64,
    height: 48,
    duration,
    size: fs.statSync(file).size,
    tech: { frameRate: 24, audioTracks: 2 },
    sourceHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  };
}
function frequency(file) {
  const samples = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-ss',
    '0.3',
    '-t',
    '0.5',
    '-ac',
    '1',
    '-ar',
    '8000',
    '-f',
    's16le',
    'pipe:1'
  ]);
  let crossings = 0;
  for (let i = 2; i < samples.length; i += 2)
    if (samples.readInt16LE(i - 2) < 0 && samples.readInt16LE(i) >= 0) crossings++;
  return crossings / (samples.length / 2 / 8000);
}

test('policy explicitly rejects HDR, high bit depth and anamorphic input and labels VFR conversion', () => {
  assert.equal(policyFor({ tech: { colorTransfer: 'smpte2084' } }).supported, false);
  assert.equal(policyFor({ tech: { pixelFormat: 'yuv420p10le' } }).supported, false);
  assert.equal(policyFor({ tech: { pixelFormat: 'rgb48le' } }).supported, false);
  assert.equal(policyFor({ tech: { pixelFormat: 'gbrpf32le' } }).supported, false);
  assert.equal(policyFor({ tech: { sampleAspectRatio: '16:15' } }).supported, false);
  assert.match(
    policyFor({ tech: { frameRateMode: 'variable-or-uncertain' } }).warnings.join(' '),
    /constant/
  );
  assert.equal(policyFor({ tech: { sampleAspectRatio: '1:1' } }).supported, true);
});

test('job admission checks its estimated working space rather than a fixed 512 MB ceiling', async (t) => {
  const { cfg, db, queue } = fixture(t, {
    storageStatfs: async () => ({ bavail: 512 * 1024 * 1024, bsize: 1 })
  });
  fs.writeFileSync(path.join(cfg.mediaDir, 'large.mp4'), 'source placeholder');
  const item = {
    id: 'large',
    relPath: 'large.mp4',
    filename: 'large.mp4',
    type: 'video',
    duration: 60,
    width: 1920,
    height: 1080,
    tech: { frameRate: 24 }
  };
  db.upsert(item);
  const budget = estimate(item, optionsFor({}, item));
  assert.ok(budget.requiredFreeBytes > 512 * 1024 * 1024);
  await assert.rejects(queue.create(item, {}), /estimated working files/);
  assert.equal(db.store.jobs().length, 0);
});

test(
  'cancellation during asynchronous progress saving cannot be overwritten by stale running state',
  { timeout: 10000 },
  async (t) => {
    let release,
      entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cfg, db, queue } = fixture(t, {
      runner: async () => {
        entered = true;
        await gate;
        return { stdout: 'ffmpeg version fixture', stderr: '' };
      }
    });
    fs.writeFileSync(path.join(cfg.mediaDir, 'clip.mp4'), 'source placeholder');
    const item = {
      id: 'clip',
      relPath: 'clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 1,
      width: 64,
      height: 48,
      tech: { frameRate: 24 }
    };
    db.upsert(item);
    await queue.start();
    const created = await queue.create(item, {});
    for (let i = 0; i < 200 && !entered; i++) await delay(10);
    queue.cancel(created.id);
    release();
    assert.equal(entered, true);
    assert.equal((await settled(queue, created.id)).state, 'cancelled');
  }
);

test(
  'a nonzero five-second sample and a full result retain all audio tracks with the correct range',
  { skip: !hasTools, timeout: 60000 },
  async (t) => {
    const { cfg, db, queue } = fixture(t),
      item = clip(cfg);
    db.upsert(item);
    const original = fs.readFileSync(path.join(cfg.mediaDir, item.relPath));
    await queue.start();
    const sample = await queue.create(item, {
      smoothing: 'ffmpeg',
      preview: true,
      start: 2,
      end: 7
    });
    const result = await settled(queue, sample.id);
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.verification.frames, 300);
    assert.equal(result.verification.audioTracks, 2);
    assert.ok(Math.abs(result.verification.duration - 5) < 0.08);
    const container = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-show_format',
          '-of',
          'json',
          path.join(queue.dir(result.id), 'enhanced.mp4')
        ],
        { encoding: 'utf8' }
      )
    );
    assert.equal(container.format.tags.title, 'Preservation test');
    assert.ok(
      Math.abs(frequency(path.join(queue.dir(result.id), 'enhanced.mp4')) - 880) < 15,
      'Sample audio starts at the selected source position'
    );
    const provenance = JSON.parse(fs.readFileSync(path.join(queue.dir(result.id), 'result.json')));
    assert.match(provenance.provenance.processingAttempt.ffmpeg, /ffmpeg version/);
    assert.equal(provenance.provenance.processingAttempt.node, process.versions.node);
    assert.equal(provenance.provenance.sourceHash, item.sourceHash);
    const full = await queue.create(item, { smoothing: 'ffmpeg' });
    const finished = await settled(queue, full.id);
    assert.equal(finished.state, 'completed', finished.error);
    assert.equal(finished.verification.frames, 480);
    assert.equal(finished.verification.audioTracks, 2);
    assert.ok(
      Math.abs(frequency(path.join(queue.dir(full.id), 'enhanced.mp4')) - 220) < 15,
      'Full result starts at the original audio position'
    );
    const dir = queue.dir(full.id),
      segment = path.join(dir, 'segment-00000000.mp4'),
      output = path.join(dir, 'enhanced.mp4');
    const verifiedSegment = fs.readFileSync(segment);
    fs.writeFileSync(output, 'corrupt');
    await assert.rejects(queue.cleanup(full.id), /verification/);
    assert.ok(fs.existsSync(segment));
    const repaired = await queue.create(item, { smoothing: 'ffmpeg' });
    assert.equal(repaired.id, full.id, 'Damaged output reuses the durable job');
    assert.equal((await settled(queue, repaired.id)).state, 'completed');
    assert.deepEqual(fs.readFileSync(segment), verifiedSegment, 'Repair reuses verified segments');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'unrelated');
    await queue.cleanup(full.id);
    assert.equal(fs.existsSync(segment), false);
    assert.ok(fs.existsSync(output));
    assert.ok(fs.existsSync(path.join(dir, 'source.mp4')));
    assert.ok(fs.existsSync(path.join(dir, 'result.json')));
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'unrelated');
    assert.deepEqual(fs.readFileSync(path.join(cfg.mediaDir, item.relPath)), original);
  }
);

test(
  'cancellation preserves verified segments and is not automatically requeued',
  { skip: !hasTools, timeout: 30000 },
  async (t) => {
    const { cfg, db, queue } = fixture(t),
      item = clip(cfg, 4.3);
    db.upsert(item);
    let cancelled = false;
    queue.runner = async (command, args, opts) => {
      if (
        !cancelled &&
        command === 'ffmpeg' &&
        args.some((value) => String(value).includes('00000001.mp4'))
      ) {
        cancelled = true;
        queue.cancel(queue.active.id);
        throw Error('Cancelled during a segment');
      }
      return run(command, args, opts);
    };
    await queue.start();
    const created = await queue.create(item, {}),
      job = await settled(queue, created.id);
    assert.equal(job.state, 'cancelled');
    assert.equal(job.segments.length, 1);
    assert.ok(fs.existsSync(path.join(queue.dir(job.id), 'segment-00000000.mp4')));
    await queue.tick();
    assert.equal(queue.active, null);
    assert.throws(() => queue.check(job), /cancelled/);
  }
);

test(
  'rotated video becomes correctly oriented pixels without applying its rotation twice',
  { skip: !hasTools, timeout: 30000 },
  async (t) => {
    const { cfg, db, queue } = fixture(t),
      item = clip(cfg, 2.2),
      file = path.join(cfg.mediaDir, item.relPath),
      rotated = path.join(cfg.mediaDir, 'rotated.mp4');
    execFileSync('ffmpeg', [
      '-y',
      ...(hasDisplayRotation ? ['-display_rotation:v:0', '90'] : []),
      '-i',
      file,
      '-map',
      '0',
      '-c',
      'copy',
      ...(!hasDisplayRotation ? ['-metadata:s:v:0', 'rotate=90'] : []),
      rotated,
      '-loglevel',
      'error'
    ]);
    const input = JSON.parse(
      execFileSync('ffprobe', ['-v', 'quiet', '-show_streams', '-of', 'json', rotated], {
        encoding: 'utf8'
      })
    ).streams.find((stream) => stream.codec_type === 'video');
    assert.ok(
      (input.side_data_list || []).some((side) => Math.abs(side.rotation) === 90) ||
        Math.abs(Number(input.tags?.rotate)) === 90,
      'Fixture contains a real rotation transform'
    );
    fs.renameSync(rotated, file);
    item.width = 48;
    item.height = 64;
    item.tech.rotation = 90;
    item.sourceHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    db.upsert(item);
    await queue.start();
    const created = await queue.create(item, {}),
      job = await settled(queue, created.id);
    assert.equal(job.state, 'completed', job.error);
    const result = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-show_streams',
          '-of',
          'json',
          path.join(queue.dir(job.id), 'enhanced.mp4')
        ],
        { encoding: 'utf8' }
      )
    );
    const video = result.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.width, 48);
    assert.equal(video.height, 64);
    assert.ok(!(video.side_data_list || []).some((side) => side.rotation && side.rotation % 360));
    assert.ok(!Number(video.tags?.rotate));
  }
);

test(
  'a variable-timing silent source produces a verified constant-rate result without inventing audio',
  { skip: !hasTools, timeout: 30000 },
  async (t) => {
    const { cfg, db, queue } = fixture(t),
      file = path.join(cfg.mediaDir, 'vfr.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x48:rate=24',
      '-t',
      '3',
      '-vf',
      'select=not(mod(n\\,2))+not(mod(n\\,5))',
      ...(ffmpegHelp.includes('-fps_mode') ? ['-fps_mode', 'vfr'] : ['-vsync', 'vfr']),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
      '-loglevel',
      'error'
    ]);
    const source = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'quiet', '-show_format', '-show_frames', '-of', 'json', file],
        { encoding: 'utf8' }
      )
    );
    const timestamps = source.frames.map((frame) => Number(frame.best_effort_timestamp_time));
    const deltas = timestamps
      .slice(1)
      .map((value, index) => Math.round((value - timestamps[index]) * 1000));
    assert.ok(
      new Set(deltas).size > 1,
      'Fixture has genuinely unequal frame presentation intervals'
    );
    const item = {
      id: 'vfr',
      relPath: 'vfr.mp4',
      filename: 'vfr.mp4',
      type: 'video',
      duration: Number(source.format.duration),
      width: 64,
      height: 48,
      tech: { frameRate: 24, frameRateMode: 'variable-or-uncertain' }
    };
    db.upsert(item);
    await queue.start();
    const created = await queue.create(item, {}),
      job = await settled(queue, created.id);
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.verification.audioTracks, 0);
    const streams = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-show_streams',
          '-of',
          'json',
          path.join(queue.dir(job.id), 'enhanced.mp4')
        ],
        { encoding: 'utf8' }
      )
    ).streams;
    assert.equal(streams[0].avg_frame_rate, '60/1');
    assert.equal(streams.length, 1);
  }
);

test('recorded model hashes prevent resuming checkpoints with changed weights', async (t) => {
  const { db, queue } = fixture(t, {
    runner: async () => ({ stdout: 'ffmpeg version test\nconfiguration: fixture', stderr: '' })
  });
  const job = {
    id: crypto.randomUUID(),
    options: { smoothing: 'rife-v4.6', upscale: 'none' },
    state: 'paused'
  };
  const dir = queue.models.dir('rife-v4.6');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flownet.param'), 'parameter file');
  fs.writeFileSync(path.join(dir, 'flownet.bin'), 'weights');
  queue.models.tools.executable = () => process.execPath;
  db.store.saveJob(job);
  const attempt = await queue.processingProvenance(job);
  assert.equal(
    attempt.models['rife-v4.6'].hashes['flownet.bin'],
    crypto.createHash('sha256').update('weights').digest('hex')
  );
  assert.match(attempt.runtimes.rife.hash, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(dir, 'flownet.bin'), 'different weights');
  await assert.rejects(queue.processingProvenance(job), /weights changed/);
});
