'use strict';
const { runImageMagick } = require('./exec');
const { toCssColor } = require('./color');
const { detectFacesAndCats } = require('./vision-faces');
const { extractText } = require('./vision-ocr');
const { computeHash } = require('./vision-hash');
const { detectObjects } = require('./vision-objects');

const ALPHA_EXTS = new Set(['.png', '.gif', '.webp']);

function parseExifDate(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function readPhotoInfo(srcPath) {
  const { stdout } = await runImageMagick([
    `${srcPath}[0]`,
    '-auto-orient',
    '-format',
    '%w|%h|%[EXIF:DateTimeOriginal]|%[EXIF:DateTime]|%[EXIF:Make]|%[EXIF:Model]|%[EXIF:LensModel]|%[EXIF:FNumber]|%[EXIF:ExposureTime]|%[EXIF:ISOSpeedRatings]|%[EXIF:FocalLength]\n',
    'info:',
  ]);
  const firstLine = stdout.split('\n')[0] || '';
  const [w, h, dateOriginal, dateFallback, make, model, lens, fNumber, exposureTime, iso, focalLength] =
    firstLine.split('|');
  const dateTaken =
    parseExifDate(dateOriginal) || parseExifDate(dateFallback) || null;
  return {
    width: Number(w) || null,
    height: Number(h) || null,
    dateTaken,
    camera: {
      make: cleanExifString(make),
      model: cleanExifString(model),
      lens: cleanExifString(lens),
      aperture: parseExifRatio(fNumber),
      exposureTime: cleanExifString(exposureTime),
      iso: cleanExifString(iso),
      focalLength: parseExifRatio(focalLength),
    },
  };
}

function cleanExifString(v) {
  const s = (v || '').trim();
  return s ? s : null;
}

function parseExifRatio(v) {
  const s = cleanExifString(v);
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = parseFloat(m[1]) / parseFloat(m[2]);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
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

function outputExtFor(srcExt) {
  return ALPHA_EXTS.has(srcExt.toLowerCase()) ? '.png' : '.jpg';
}

async function makeDerivative(srcPath, destPath, maxSize, quality) {
  const args = [
    `${srcPath}[0]`,
    '-auto-orient',
    '-resize', `${maxSize}x${maxSize}>`,
    '-strip',
  ];
  if (destPath.endsWith('.jpg') || destPath.endsWith('.jpeg')) {
    args.push('-quality', String(quality));
  }
  args.push(destPath);
  await runImageMagick(args);
}

async function makeSizes(srcPath, pathFn, widths, ext, quality) {
  const sorted = [...widths].sort((a, b) => b - a);
  const made = [];
  for (const w of sorted) {
    const dest = pathFn(w, ext);
    await makeDerivative(srcPath, dest, w, quality);
    made.push({ width: w, path: dest });
  }
  return made;
}

async function processPhoto(srcPath, srcExt, paths, cfg, { stage = 'all', previous = null } = {}) {
  const outExt = outputExtFor(srcExt);

  if (stage === 'analysis') {
    const widths = [...cfg.thumbnailSizes].sort((a, b) => b - a);
    const sample = paths.thumb(widths[0], outExt);
    const [vision, ocrText, pHash, objects] = await Promise.all([
      detectFacesAndCats(sample, cfg), extractText(srcPath, cfg),
      computeHash(paths.thumb(widths[widths.length - 1], outExt), cfg), detectObjects(sample, cfg),
    ]);
    return { faceCount: vision.faceCount, hasFace: vision.hasFace === true,
      hasCat: vision.hasCat === true, ocrText, hasText: ocrText.length > 0, pHash, objects };
  }
  if (stage === 'preview') {
    await makeSizes(srcPath, paths.large, cfg.largeSizes, outExt, 88);
    return { largeExt: outExt };
  }

  const info = await readPhotoInfo(srcPath);
  const thumbMade = await makeSizes(srcPath, paths.thumb, cfg.thumbnailSizes, outExt, 82);
  if (stage === 'basic') {
    return { type: 'photo', ...info,
      color: await dominantColor(thumbMade[thumbMade.length - 1].path),
      isAnimated: srcExt.toLowerCase() === '.gif', thumbExt: outExt, largeExt: outExt,
      duration: null, hasAudio: false };
  }
  const largeMade = await makeSizes(srcPath, paths.large, cfg.largeSizes, outExt, 88);

  const sampleFrom = largeMade[largeMade.length - 1] || { path: paths.thumb(cfg.thumbnailSizes[0], outExt) };
  const color = await dominantColor(sampleFrom.path);

  const detectFrom = sampleFrom.path;
  const smallestThumb = thumbMade[thumbMade.length - 1] || sampleFrom;
  const [vision, ocrText, pHash, objects] = await Promise.all([
    detectFacesAndCats(detectFrom, cfg),
    extractText(srcPath, cfg),
    computeHash(smallestThumb.path, cfg),
    detectObjects(detectFrom, cfg),
  ]);

  return {
    type: 'photo',
    width: info.width,
    height: info.height,
    dateTaken: info.dateTaken,
    camera: info.camera,
    color,
    isAnimated: srcExt.toLowerCase() === '.gif',
    thumbExt: outExt,
    largeExt: outExt,
    duration: null,
    hasAudio: false,
    faceCount: vision.faceCount,
    hasFace: vision.hasFace,
    hasCat: vision.hasCat,
    ocrText,
    hasText: ocrText.length > 0,
    pHash,
    objects,
  };
}

module.exports = { processPhoto, parseExifDate };
