'use strict';
const { run } = require('./exec');

const probes = new Map();

function deviceArgs(device) {
  return ['-init_hw_device', `qsv=vidstream:hw,child_device=${device}`];
}

function qsvArgs(quality) {
  return ['-c:v', 'h264_qsv', '-global_quality', String(quality), '-pix_fmt', 'nv12'];
}

function quickSyncReady(device) {
  if (!probes.has(device)) {
    const ready = run('ffmpeg', ['-nostdin', '-v', 'error', ...deviceArgs(device),
      '-f', 'lavfi', '-i', 'color=size=128x128:rate=24', '-frames:v', '4',
      ...qsvArgs(24), '-f', 'null', '-'], { timeout: 10_000 }).then(() => {
        console.log('[stream] Quick Sync H.264 encode is available.');
        return true;
      }, () => {
        console.warn('[stream] Quick Sync is unavailable on the configured device. Using software encoding.');
        return false;
      });
    probes.set(device, ready);
  }
  return probes.get(device);
}

async function encodeH264(cfg, input, output, { quality, threads, timeout }) {
  const device = cfg.qsvDevice || '/dev/dri/renderD128';
  if (cfg.videoEncoder === 'qsv' && await quickSyncReady(device)) {
    try {
      return await run('ffmpeg', [...deviceArgs(device), ...input, ...qsvArgs(quality), ...output], { timeout });
    } catch {
      console.warn('[stream] Quick Sync could not encode a clip. Retrying it with software encoding.');
    }
  }
  const encoder = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality), '-pix_fmt', 'yuv420p'];
  if (threads) encoder.push('-threads', String(threads));
  return run('ffmpeg', [...input, ...encoder, ...output], { timeout });
}

module.exports = { encodeH264 };
