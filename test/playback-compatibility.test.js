'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { PlaybackService } = require('../lib/playback-service');

const hasTools =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function finished(job) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (job.state === 'completed' || job.state === 'failed') return job;
    await pause(10);
  }
  throw Error('Compatibility preparation timed out');
}
function encode(file, { legacy = false, red = false } = {}) {
  const input = red ? 'color=c=red:size=64x48:rate=24' : 'testsrc2=size=64x48:rate=24';
  const args = ['-y', '-f', 'lavfi', '-i', input];
  if (legacy) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', '0.6', '-c:v', legacy ? 'mpeg4' : 'libx264', '-pix_fmt', 'yuv420p');
  if (legacy) args.push('-c:a', 'pcm_s16le');
  args.push(file, '-loglevel', 'error');
  execFileSync('ffmpeg', args);
}
function fixture(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidstream-playback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { mediaDir: path.join(root, 'media'), cacheDir: path.join(root, 'cache') };
  fs.mkdirSync(cfg.mediaDir);
  const filename = legacy ? 'clip.avi' : 'clip.mp4',
    source = path.join(cfg.mediaDir, filename);
  encode(source, { legacy });
  const sourceHash = hash(source),
    item = {
      id: 'clip',
      mediaId: crypto.randomUUID(),
      relPath: filename,
      filename,
      sourceHash,
      sourceVersion: sourceHash,
      width: 64,
      height: 48,
      duration: 0.6,
      hasAudio: legacy,
      tech: {
        videoCodec: legacy ? 'mpeg4' : 'h264',
        audioCodec: legacy ? 'pcm_s16le' : null,
        pixelFormat: 'yuv420p',
        bitDepth: 8
      }
    };
  const db = { get: (id) => (id === item.id || id === item.mediaId ? item : null) };
  return { root, cfg, item, source, db, service: new PlaybackService(cfg, db, null) };
}
function receiptFor(service, item) {
  return service.file(item).replace(/\.mp4$/, '.json');
}

test(
  'remux writes a durable verified receipt and reuses it after restart or source outage',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      before = hash(f.source),
      job = await f.service.prepare(f.item);
    await finished(job);
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.mode, 'remux / audio adaptation');
    const receipt = JSON.parse(fs.readFileSync(receiptFor(f.service, f.item), 'utf8'));
    assert.equal(receipt.sourceHash, before);
    assert.equal(receipt.sourceVersion, f.item.sourceVersion);
    assert.equal(receipt.outputHash, hash(f.service.file(f.item)));
    assert.equal(receipt.size, fs.statSync(f.service.file(f.item)).size);
    assert.deepEqual(
      [receipt.verification.width, receipt.verification.height, receipt.verification.audioTracks],
      [64, 48, 0]
    );
    assert.ok(Math.abs(receipt.verification.duration - 0.6) < 0.1);
    fs.renameSync(f.source, f.source + '.offline');
    const restarted = new PlaybackService(f.cfg, f.db, {
      run() {
        throw Error('A verified cache should not need another encode');
      }
    });
    const reused = await restarted.prepare(f.item);
    assert.equal(reused.state, 'completed');
    assert.equal(reused.mode, receipt.mode);
    fs.renameSync(f.source + '.offline', f.source);
    assert.equal(hash(f.source), before);
  }
);

test(
  'truncated or same-length corrupted caches are rebuilt and existing receipts are verified',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      before = hash(f.source);
    assert.equal((await finished(await f.service.prepare(f.item))).state, 'completed');
    const output = f.service.file(f.item),
      receiptPath = receiptFor(f.service, f.item);
    fs.truncateSync(output, 32);
    assert.equal((await finished(await f.service.prepare(f.item))).state, 'completed');
    assert.ok(fs.statSync(output).size > 32);
    const bytes = fs.readFileSync(output);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(output, bytes);
    const restarted = new PlaybackService(f.cfg, f.db, null);
    assert.equal((await finished(await restarted.prepare(f.item))).state, 'completed');
    assert.equal(hash(output), JSON.parse(fs.readFileSync(receiptPath, 'utf8')).outputHash);
    fs.writeFileSync(receiptPath, '{incomplete receipt');
    assert.equal((await finished(await restarted.prepare(f.item))).state, 'completed');
    assert.equal(hash(f.source), before);
    assert.ok(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).verification.width > 0);
  }
);

test(
  'legacy video and PCM audio are encoded as verified H.264/AAC without modifying the original',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t, { legacy: true }),
      before = hash(f.source),
      job = await finished(await f.service.prepare(f.item));
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.mode, 'compatibility encode');
    const data = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-of', 'json', f.service.file(f.item)],
        { encoding: 'utf8' }
      )
    );
    assert.equal(data.streams.find((stream) => stream.codec_type === 'video').codec_name, 'h264');
    assert.equal(data.streams.find((stream) => stream.codec_type === 'audio').codec_name, 'aac');
    assert.equal(job.verification.audioTracks, 1);
    assert.equal(hash(f.source), before);
  }
);

test(
  'a changed source version gets a separate cache and cannot adopt an old receipt',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t);
    assert.equal((await finished(await f.service.prepare(f.item))).state, 'completed');
    const originalCache = f.service.file(f.item),
      originalHash = hash(originalCache);
    encode(f.source, { red: true });
    f.item.sourceVersion = f.item.sourceHash = hash(f.source);
    const newCache = f.service.file(f.item);
    assert.notEqual(newCache, originalCache);
    // Even a misplaced receipt/output cannot be accepted for another version.
    fs.copyFileSync(originalCache, newCache);
    fs.copyFileSync(originalCache.replace(/\.mp4$/, '.json'), newCache.replace(/\.mp4$/, '.json'));
    const next = await finished(await new PlaybackService(f.cfg, f.db, null).prepare(f.item));
    assert.equal(next.state, 'completed', next.error);
    assert.equal(hash(originalCache), originalHash);
    assert.equal(
      JSON.parse(fs.readFileSync(newCache.replace(/\.mp4$/, '.json'), 'utf8')).sourceHash,
      f.item.sourceHash
    );
  }
);

test(
  'queued playback binds a source snapshot and fails if the catalog version changes before work starts',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const service = new PlaybackService(f.cfg, f.db, {
      run(_kind, _label, execute) {
        return gate.then(execute);
      }
    });
    const job = await service.prepare(f.item),
      oldCache = service.file(f.item);
    encode(f.source, { red: true });
    f.item.sourceHash = f.item.sourceVersion = hash(f.source);
    release();
    await finished(job);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /Source version changed/);
    assert.equal(fs.existsSync(oldCache), false);
    const retry = await finished(await service.prepare(f.item));
    assert.equal(retry.state, 'completed', retry.error);
  }
);

test(
  'uncataloged source replacement fails verification and can retry after reconciliation',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t);
    encode(f.source, { red: true });
    const replacementHash = hash(f.source);
    assert.notEqual(replacementHash, f.item.sourceHash);
    const job = await finished(await f.service.prepare(f.item));
    assert.equal(job.state, 'failed');
    assert.match(job.error, /Source bytes changed/);
    assert.equal(fs.existsSync(f.service.file(f.item)), false);
    assert.equal(hash(f.source), replacementHash);
    f.item.sourceHash = f.item.sourceVersion = replacementHash;
    const retry = await finished(await f.service.prepare(f.item));
    assert.equal(retry.state, 'completed', retry.error);
    assert.equal(hash(f.source), replacementHash);
  }
);

test(
  'rotation metadata remains valid in a remux and its receipt records display dimensions',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      rotated = path.join(f.cfg.mediaDir, 'rotated.mp4');
    const hasDisplayRotation = spawnSync('ffmpeg', ['-h', 'full'], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024
    }).stdout.includes('-display_rotation');
    const args = ['-y'];
    if (hasDisplayRotation) args.push('-display_rotation:v:0', '90');
    args.push('-i', f.source, '-c', 'copy');
    if (!hasDisplayRotation) args.push('-metadata:s:v:0', 'rotate=90');
    args.push(rotated, '-loglevel', 'error');
    execFileSync('ffmpeg', args);
    const sourceVideo = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', rotated], {
        encoding: 'utf8'
      })
    ).streams.find((stream) => stream.codec_type === 'video');
    const rotation = Number(
      sourceVideo.side_data_list?.find((data) => Number.isFinite(data.rotation))?.rotation ??
        sourceVideo.tags?.rotate
    );
    assert.equal(
      Math.abs(rotation) % 180,
      90,
      'The real input fixture must carry a quarter-turn display rotation'
    );
    fs.renameSync(rotated, f.source);
    f.item.sourceHash = f.item.sourceVersion = hash(f.source);
    f.item.width = 48;
    f.item.height = 64;
    const before = hash(f.source),
      job = await finished(await f.service.prepare(f.item));
    assert.equal(job.state, 'completed', job.error);
    assert.deepEqual([job.verification.width, job.verification.height], [48, 64]);
    assert.equal(hash(f.source), before);
  }
);

test(
  'known HDR input is refused without generating an unlabelled SDR replacement',
  { skip: !hasTools },
  async (t) => {
    const f = fixture(t),
      before = hash(f.source);
    f.item.tech.colorTransfer = 'smpte2084';
    const job = await finished(await f.service.prepare(f.item));
    assert.equal(job.state, 'failed');
    assert.match(job.error, /HDR-capable/);
    assert.equal(fs.existsSync(f.service.file(f.item)), false);
    assert.equal(hash(f.source), before);
  }
);
