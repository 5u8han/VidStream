'use strict';
const { run } = require('./exec');
const { toCssColor } = require('./color');
const { detectFacesAndCats } = require('./vision-faces');
const { extractText } = require('./vision-ocr');
const { computeHash } = require('./vision-hash');
const { detectObjects } = require('./vision-objects');

async function probe(srcPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    srcPath,
  ]);
  return JSON.parse(stdout);
}

// ffmpeg's CLI auto-rotates decoded frames using the stream's display
// matrix by default (has since ~4.3), so extracted posters/previews
// come out visually correct without us adding a transpose filter --
// doing that ourselves risks double-rotating. What we still need to
// fix by hand is the *reported* width/height for aspect-ratio math in
// the grid, since ffprobe's coded_width/height reflect the raw frame
// before rotation is applied.
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

// ffprobe reports frame rate as a rational string like "30/1" or
// "30000/1001" (the latter for NTSC-derived rates) rather than a
// plain number.
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
    const { stdout } = await run('convert', [
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

// Generates the poster frame at every configured width, sorted
// largest-first so the smallest lands last (used for the color sample).
async function makePosterSizes(srcPath, posterTime, pathFn, widths) {
  const sorted = [...widths].sort((a, b) => b - a);
  const made = [];
  for (const w of sorted) {
    const dest = pathFn(w, '.jpg');
    await run('ffmpeg', [
      '-y',
      '-ss', String(posterTime),
      '-i', srcPath,
      '-frames:v', '1',
      '-vf', `scale='min(${w},iw)':-2`,
      '-q:v', '3',
      dest,
      '-loglevel', 'error',
    ], { timeout: 45_000 });
    made.push({ width: w, path: dest });
  }
  return made;
}

async function processVideo(srcPath, paths, cfg) {
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
    frameRate: parseFrameRate(videoStream && videoStream.r_frame_rate),
    bitRate: parseInt(meta.format && meta.format.bit_rate, 10) || null,
  };

  const previewPath = paths.preview('.mp4');
  const posterTime = duration > 0.5 ? Math.min(1, duration * 0.1) : 0;
  const posterMade = await makePosterSizes(srcPath, posterTime, paths.poster, cfg.posterSizes);

  const previewLen = Math.min(cfg.videoPreviewDuration, duration || cfg.videoPreviewDuration);
  await run('ffmpeg', [
    '-y',
    '-i', srcPath,
    '-t', String(previewLen || cfg.videoPreviewDuration),
    '-vf', `scale='min(${cfg.videoPreviewMaxWidth},iw)':-2,fps=15`,
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '30',
    '-movflags', '+faststart',
    previewPath,
    '-loglevel', 'error',
  ], { timeout: 180_000 });

  const smallestPoster = posterMade[posterMade.length - 1];
  const largestPoster = posterMade[0];
  const color = await dominantColor(smallestPoster.path);

  // Detection runs on the poster frame -- the one already-generated
  // image standing in for the video -- not on every frame.
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
    dateTaken, // null falls back to filesystem mtime in the scanner
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

module.exports = { processVideo };
