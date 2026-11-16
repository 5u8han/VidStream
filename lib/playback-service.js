'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./exec');
const { encodeH264 } = require('./video-encoder');
const { atomicJson, commitFile, digest } = require('./durable-files');
const { sourceVersion } = require('./catalog');
const { resolveMediaSource } = require('./serve-file');

function keyFor(item) {
  return crypto
    .createHash('sha256')
    .update((item.mediaId || item.id) + ':' + sourceVersion(item))
    .digest('hex');
}
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file
  ]);
  const data = JSON.parse(stdout),
    video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  if (!video || !(video.width > 0) || !(video.height > 0))
    throw Error('Compatibility output has no valid video dimensions');
  const rotation =
    (((Number(
      video.side_data_list?.find((data) => Number.isFinite(data.rotation))?.rotation ??
        video.tags?.rotate
    ) || 0) %
      360) +
      360) %
    360;
  const rotated = rotation === 90 || rotation === 270;
  const duration = Number(data.format?.duration || video.duration);
  if (!(duration > 0) || !Number.isFinite(duration))
    throw Error('Compatibility output has no valid duration');
  return {
    video,
    audio: data.streams.filter((stream) => stream.codec_type === 'audio'),
    duration,
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height
  };
}
function sameStat(before, after) {
  return before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev;
}

class PlaybackService {
  constructor(cfg, db, coordinator) {
    Object.assign(this, { cfg, db, coordinator });
    this.jobs = new Map();
    this.preparing = new Map();
    this.completion = new WeakMap();
    this.verifiedOutputs = new Map();
    this.root = path.join(cfg.cacheDir, 'playback');
  }
  prepare(item, { retry = false } = {}) {
    const snapshot = { ...item, tech: { ...item.tech } },
      key = keyFor(snapshot);
    if (this.preparing.has(key)) return this.preparing.get(key);
    const output = this.file(snapshot);
    const prepare = () => this.prepareOne(snapshot, key, retry);
    const request = this.cfg.derivativeCache?.withLease(output, prepare) || prepare();
    this.preparing.set(key, request);
    request.finally(() => this.preparing.delete(key)).catch(() => {});
    return request;
  }
  async retry(item) {
    const job = await this.prepare(item, { retry: true });
    await this.completion.get(job);
    if (job.state !== 'completed') throw Error(job.error || 'Could not prepare compatible playback.');
  }
  current(item) {
    const current = this.db.get(item.mediaId || item.id);
    if (!current || sourceVersion(current) !== sourceVersion(item))
      throw Error('Source version changed while preparing playback; reopen the video');
  }
  async cached(item, key, output) {
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(this.root, key + '.json'), 'utf8'));
      if (
        receipt.version !== 1 ||
        receipt.key !== key ||
        receipt.mediaId !== (item.mediaId || item.id) ||
        receipt.sourceVersion !== sourceVersion(item)
      )
        return null;
      if (item.sourceHash && receipt.sourceHash !== item.sourceHash) return null;
      const result = receipt.verification;
      if (
        !/^[a-f0-9]{64}$/.test(receipt.sourceHash) ||
        !/^[a-f0-9]{64}$/.test(receipt.outputHash) ||
        !(receipt.size > 0) ||
        !(result?.width > 0) ||
        !(result?.height > 0) ||
        !(result?.duration > 0)
      )
        return null;
      if (
        result.videoCodec !== 'h264' ||
        !/^(yuv420p|yuvj420p)$/.test(result.pixelFormat || '') ||
        !Number.isInteger(result.audioTracks) ||
        result.audioTracks < 0
      )
        return null;
      const stat = await fs.stat(output);
      if (!stat.isFile() || stat.size !== receipt.size) return null;
      const previous = this.verifiedOutputs.get(key);
      if (previous?.hash !== receipt.outputHash || !sameStat(previous.stat, stat)) {
        if (await digest(output) !== receipt.outputHash || !sameStat(stat, await fs.stat(output))) return null;
      }
      this.rememberOutput(key, stat, receipt.outputHash);
      return receipt;
    } catch {
      return null;
    }
  }
  rememberOutput(key, stat, hash) {
    this.verifiedOutputs.delete(key);
    this.verifiedOutputs.set(key, { stat, hash });
    if (this.verifiedOutputs.size > 128) this.verifiedOutputs.delete(this.verifiedOutputs.keys().next().value);
  }
  async prepareOne(item, key, retry) {
    const existing = this.jobs.get(key);
    if (existing && (['queued', 'running'].includes(existing.state) || existing.state === 'failed' && !retry)) return existing;
    const output = path.join(this.root, key + '.mp4'),
      url = '/api/items/' + encodeURIComponent(item.id) + '/playback/video';
    const receipt = await this.cached(item, key, output);
    this.current(item);
    if (receipt) {
      const complete = {
        state: 'completed',
        url,
        key,
        mode: receipt.mode,
        verification: receipt.verification
      };
      this.jobs.set(key, complete);
      return complete;
    }
    const job = { state: 'queued', url, label: 'Preparing compatible playback', key };
    this.jobs.set(key, job);
    const execute = async () => {
      job.state = 'running';
      this.current(item);
      await fs.mkdir(this.root, { recursive: true });
      const source = await resolveMediaSource(this.cfg.mediaDir, item.relPath);
      const initialStat = await fs.stat(source),
        input = await probe(source);
      if (
        /smpte2084|arib-std-b67/i.test(
          [input.video.color_transfer, item.tech.colorTransfer].join(' ')
        )
      )
        throw Error(
          'This source needs HDR-capable playback. Automatic SDR conversion is not enabled; play the original in a compatible player.'
        );
      const inputHash = item.sourceHash || (await digest(source));
      const videoCompatible =
        input.video.codec_name === 'h264' && /^(yuv420p|yuvj420p)$/.test(input.video.pix_fmt || '');
      const audioCompatible = input.audio.every((stream) => stream.codec_name === 'aac');
      const temp = path.join(this.root, key + '.partial.mp4');
      const inputArgs = ['-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-sn'];
      const outputArgs = [
        ...(audioCompatible ? ['-c:a', 'copy'] : ['-c:a', 'aac']),
        '-map_metadata',
        '0',
        '-movflags',
        '+faststart',
        temp,
        '-loglevel',
        'error'
      ];
      if (videoCompatible) {
        await run('ffmpeg', [...inputArgs, '-c:v', 'copy', ...outputArgs], { timeout: 3600000 });
      } else {
        await encodeH264(this.cfg, inputArgs, outputArgs, { quality: 21, timeout: 3600000 });
      }
      const result = await probe(temp);
      if (
        result.video.codec_name !== 'h264' ||
        !/^(yuv420p|yuvj420p)$/.test(result.video.pix_fmt || '') ||
        result.audio.some((stream) => stream.codec_name !== 'aac')
      )
        throw Error('Compatibility output failed codec verification');
      if (
        result.width !== input.width ||
        result.height !== input.height ||
        Math.abs(result.duration - input.duration) > Math.max(0.3, input.duration * 0.02) ||
        result.audio.length !== input.audio.length
      )
        throw Error('Compatibility output failed dimensions, duration or audio verification');
      const outputHash = await digest(temp),
        stat = await fs.stat(temp);
      this.current(item);
      if (!sameStat(initialStat, await fs.stat(source)) || (await digest(source)) !== inputHash)
        throw Error(
          'Source bytes changed while preparing playback; source and existing cache retained'
        );
      this.current(item);
      await commitFile(temp, output);
      const mode = videoCompatible ? 'remux / audio adaptation' : 'compatibility encode';
      const verification = {
        width: result.width,
        height: result.height,
        duration: result.duration,
        videoCodec: 'h264',
        pixelFormat: result.video.pix_fmt,
        audioTracks: result.audio.length
      };
      await atomicJson(path.join(this.root, key + '.json'), {
        version: 1,
        key,
        mediaId: item.mediaId || item.id,
        sourceVersion: sourceVersion(item),
        sourceHash: inputHash,
        outputHash,
        size: stat.size,
        verification,
        mode,
        createdAt: new Date().toISOString()
      });
      this.current(item);
      Object.assign(job, { state: 'completed', mode, verification });
    };
    const encode = () => this.cfg.derivativeCache?.withLease(output, execute) || execute();
    const work = this.coordinator
      ? this.coordinator.run('playback', item.filename, encode, {
          path: item.relPath,
          priority: 0,
          heavy: true,
          identity: 'playback-' + key
        })
      : encode();
    const completion = work.catch((error) => {
      job.state = 'failed';
      job.error = error.message;
    });
    this.completion.set(job, completion);
    return job;
  }
  file(item) {
    return path.resolve(this.root, keyFor(item) + '.mp4');
  }
}
module.exports = { PlaybackService };
