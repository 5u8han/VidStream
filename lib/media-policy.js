'use strict';

function policyFor(item) {
  const tech = item.tech || {};
  const hdr = /smpte2084|arib-std-b67/i.test(tech.colorTransfer || '');
  const format = tech.pixelFormat || '';
  const formatDepth = format.match(
    /(?:p[024]?|gray|rgb|bgr|rgba|bgra|x2rgb|x2bgr)f?(9|10|12|14|16|32)(?:le|be)?$/
  );
  const depth =
    Number(tech.bitDepth) ||
    (formatDepth
      ? Number(formatDepth[1])
      : /(?:rgb|bgr)48|(?:rgba|bgra|argb|abgr)64/.test(format)
        ? 16
        : 8);
  const sar = String(tech.sampleAspectRatio || '1:1')
    .split(':')
    .map(Number);
  const anamorphic = sar.length === 2 && sar[0] > 0 && sar[1] > 0 && sar[0] !== sar[1];
  return {
    id: 'sdr-h264-v1',
    label: 'SDR H.264 · 8-bit · AAC audio',
    supported: !hdr && depth <= 8 && !anamorphic,
    reason:
      hdr || depth > 8
        ? 'This enhancement chain currently supports SDR 8-bit sources. HDR / high-bit-depth input is retained unchanged; use a verified color conversion workflow before enhancing it.'
        : anamorphic
          ? 'Anamorphic input needs a verified square-pixel conversion before enhancement. The original is retained unchanged.'
          : null,
    preserves: [
      'Original source snapshot',
      'Capture metadata where the MP4 container supports it',
      'All source audio tracks, encoded as AAC'
    ],
    conversions: [
      'Constant output frame rate',
      'H.264 8-bit output',
      'Source rotation is baked into square-pixel output',
      'AAC audio; subtitles are not included'
    ],
    warnings: [
      tech.subtitleTracks
        ? 'Source subtitles stay with the original; this enhancement output does not include them.'
        : null,
      /^variable/.test(tech.frameRateMode || '')
        ? 'Variable-frame-rate input is resampled to the chosen constant output rate.'
        : null
    ].filter(Boolean)
  };
}
function sourceVersion(item) {
  return require('./catalog').sourceVersion(item);
}
function jobMatches(job, item) {
  return (
    (job.sourceVersion || sourceVersion({ fingerprint: job.sourceFingerprint })) ===
    sourceVersion(item)
  );
}
function estimate(item, options) {
  const seconds = options.preview ? options.end - options.start : item.duration;
  const fps = options.fps || 60,
    scale = options.scale || 1;
  const frameBytes = (item.width || 0) * (item.height || 0) * 3;
  const frames = Math.ceil(seconds * fps);
  // AI paths retain decoded/generated PNGs; CPU-only work retains encoded
  // segments. Compression varies, so this estimate is not a reservation.
  const workingBytes = Math.ceil(
    (item.size || 0) +
      frameBytes *
        frames *
        (options.upscale !== 'none'
          ? scale * scale + 2
          : options.smoothing === 'rife-v4.6'
            ? 2
            : 0.15)
  );
  const reserveBytes = 128 * 1024 * 1024;
  return {
    seconds,
    frames,
    workingBytes,
    outputPixels: [item.width * scale, item.height * scale],
    reserveBytes,
    requiredFreeBytes: workingBytes + reserveBytes,
    note: 'Conservative working estimate plus 128 MiB free-space reserve. Actual compression and other jobs can change usage; this is an admission check, not a disk reservation. Time estimates appear after a completed sample.'
  };
}
module.exports = { policyFor, sourceVersion, jobMatches, estimate };
