'use strict';
const { run, runImageMagick } = require('./exec');
const { encodeH264 } = require('./video-encoder');
const { toCssColor } = require('./color');
const { detectFacesAndCats } = require('./vision-faces');
const { extractText } = require('./vision-ocr');
const { computeHash } = require('./vision-hash');
const { detectObjects } = require('./vision-objects');

async function probe(srcPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    srcPath,
  ]);
  return JSON.parse(stdout);
}

function readRotation(videoStream) {
  if (!videoStream) return 0;
  const sideData = (videoStream.side_data_list || []).find(
    (d) => typeof d.rotation === 'number'
  );
  if (sideData) return ((sideData.rotation % 360) + 360) % 360;
  const tag = videoStream.tags && videoStream.tags.rotate;
  if (tag) return ((parseInt(tag, 10) % 360) + 360) % 360;
  return 0;
}

function parseFrameRate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const den = parseInt(m[2], 10);
  if (!den) return null;
  return Math.round((parseInt(m[1], 10) / den) * 100) / 100;
}

function readCreationTime(meta, videoStream) {
  const raw =
    (meta.format && meta.format.tags && meta.format.tags.creation_time) ||
    (videoStream && videoStream.tags && videoStream.tags.creation_time);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function dominantColor(imagePath) {
  try {
    const { stdout } = await runImageMagick([
      imagePath,
      '-resize', '1x1!',
      '-format', '%[pixel:p{0,0}]',
      'info:',
    ]);
    return toCssColor(stdout.trim());
  } catch {
    return '#888888';
  }
}

async function makePosterSizes(srcPath, posterTime, pathFn, widths) {
  const sorted = [...widths].sort((a, b) => b - a);
  const made = sorted.map(width => ({ width, path: pathFn(width, '.jpg') }));
  const outputs = ['-y', '-ss', String(posterTime), '-threads', '2', '-i', srcPath];
  if (made.length > 1) {
    const splitLabels = made.map((_, i) => `[frame${i}]`).join('');
    const scales = made.map(({ width }, i) => `[frame${i}]scale='min(${width},iw)':-2[poster${i}]`);
    outputs.push('-filter_complex_threads', '1', '-filter_complex',
      `[0:v:0]split=${made.length}${splitLabels};${scales.join(';')}`);
  }
  for (const [index, { width, path }] of made.entries()) {
    if (made.length === 1) outputs.push('-map', '0:v:0', '-filter_threads', '1', '-vf', `scale='min(${width},iw)':-2`);
    else outputs.push('-map', `[poster${index}]`);
    outputs.push('-an', '-frames:v', '1', '-threads', '1', '-q:v', '3', path);
  }
  await run('ffmpeg', [...outputs, '-loglevel', 'error'], { timeout: 45_000 });
  return made;
}

function makePreview(srcPath, output, duration, fps, cfg, start = 0) {
  const seek = start ? ['-ss', String(start)] : [];
  const streams = start ? ['-map', '0:V:0'] : [];
  return encodeH264(cfg, ['-y', ...seek, '-threads', '2', '-i', srcPath, ...streams, '-t', String(duration), '-filter_threads', '1',
    '-vf', `scale='min(${cfg.videoPreviewMaxWidth},iw)':-2,fps=${fps}`, '-an'],
  ['-movflags', '+faststart', output, '-loglevel', 'error'],
  { quality: 30, threads: 2, timeout: start ? 30_000 : 180_000 });
}

function makeTimelineClip(srcPath, output, item, minute, cfg) {
  const fps = Math.max(1, Math.min(cfg.videoPreviewFps || 60, item.tech?.frameRate || 30));
  return makePreview(srcPath, output, 5, fps, cfg, minute * 60);
}

async function processVideo(srcPath, paths, cfg, { stage = 'all', previous = null } = {}) {
  if (stage === 'analysis') {
    const widths = [...cfg.posterSizes].sort((a, b) => b - a);
    const largest = paths.poster(widths[0], '.jpg');
    const smallest = paths.poster(widths[widths.length - 1], '.jpg');
    const [vision, ocrText, pHash, objects] = await Promise.all([
      detectFacesAndCats(largest, cfg), extractText(largest, cfg),
      computeHash(smallest, cfg), detectObjects(largest, cfg),
    ]);
    return { faceCount: vision.faceCount, hasFace: vision.hasFace === true,
      hasCat: vision.hasCat === true, ocrText, hasText: ocrText.length > 0, pHash, objects };
  }
  if (stage === 'preview') {
    const tech = { ...(previous?.tech || {}) };
    const previewLen = Math.min(cfg.videoPreviewDuration, previous?.duration || cfg.videoPreviewDuration);
    const previewFps = Math.max(1, Math.min(cfg.videoPreviewFps || 60, tech.frameRate || 30));
    await makePreview(srcPath, paths.preview('.mp4'), previewLen, previewFps, cfg);
    tech.previewFrameRate = previewFps;
    return { tech };
  }
  const meta = await probe(srcPath);
  const videoStream = (meta.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (meta.streams || []).find((s) => s.codec_type === 'audio');
  const hasAudio = Boolean(audioStream);
  const duration = parseFloat(meta.format && meta.format.duration) || 0;
  const dateTaken = readCreationTime(meta, videoStream);

  let width = (videoStream && videoStream.width) || null;
  let height = (videoStream && videoStream.height) || null;
  const rotation = readRotation(videoStream);
  if ((rotation === 90 || rotation === 270) && width && height) {
    [width, height] = [height, width];
  }

  const tech = {
    videoCodec: (videoStream && videoStream.codec_name) || null,
    audioCodec: (audioStream && audioStream.codec_name) || null,
    frameRate: parseFrameRate(videoStream && videoStream.avg_frame_rate) || parseFrameRate(videoStream && videoStream.r_frame_rate),
    bitRate: parseInt(meta.format && meta.format.bit_rate, 10) || null,
    pixelFormat: videoStream?.pix_fmt || null,
    bitDepth: Number(videoStream?.bits_per_raw_sample) || (/10|12/.test(videoStream?.pix_fmt || '') ? Number((videoStream.pix_fmt.match(/(10|12)/) || [])[1]) : 8),
    colorSpace: videoStream?.color_space || null, colorTransfer: videoStream?.color_transfer || null,
    colorPrimaries: videoStream?.color_primaries || null, rotation,
    audioTracks: (meta.streams || []).filter(s => s.codec_type === 'audio').length,
    subtitleTracks: (meta.streams || []).filter(s => s.codec_type === 'subtitle').length,
    sampleAspectRatio: videoStream?.sample_aspect_ratio || null,
    frameRateMode: videoStream?.avg_frame_rate && videoStream?.r_frame_rate && videoStream.avg_frame_rate !== videoStream.r_frame_rate ? 'variable-or-uncertain' : 'nominal-constant',
  };

  const previewPath = paths.preview('.mp4');
  const posterTime = duration > 0.5 ? Math.min(1, duration * 0.1) : 0;
  const posterMade = await makePosterSizes(srcPath, posterTime, paths.poster, cfg.posterSizes);
  if (stage === 'basic') {
    return { type: 'video', width, height, dateTaken, tech,
      color: await dominantColor(posterMade[posterMade.length - 1].path),
      isAnimated: false, duration, hasAudio };
  }

  const previewLen = Math.min(cfg.videoPreviewDuration, duration || cfg.videoPreviewDuration);
  const sourceFps = tech.frameRate || 30;
  const previewFps = Math.max(1, Math.min(cfg.videoPreviewFps || 60, sourceFps));
  tech.previewFrameRate = previewFps;
  await makePreview(srcPath, previewPath, previewLen || cfg.videoPreviewDuration, previewFps, cfg);

  const smallestPoster = posterMade[posterMade.length - 1];
  const largestPoster = posterMade[0];
  const color = await dominantColor(smallestPoster.path);

  const [vision, ocrText, pHash, objects] = await Promise.all([
    detectFacesAndCats(largestPoster.path, cfg),
    extractText(largestPoster.path, cfg),
    computeHash(smallestPoster.path, cfg),
    detectObjects(largestPoster.path, cfg),
  ]);

  return {
    type: 'video',
    width,
    height,
    dateTaken,
    tech,
    color,
    isAnimated: false,
    duration,
    hasAudio,
    faceCount: vision.faceCount,
    hasFace: vision.hasFace,
    hasCat: vision.hasCat,
    ocrText,
    hasText: ocrText.length > 0,
    pHash,
    objects,
  };
}

module.exports = { processVideo, makeTimelineClip };
