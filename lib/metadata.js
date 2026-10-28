'use strict';
const { run } = require('./exec');
async function readMetadata(file) {
  try {
    const { stdout } = await run('exiftool', ['-json', '-n', '-Make', '-Model', '-LensModel',
      '-Software', '-DateTimeOriginal', '-CreateDate', '-GPSLatitude', '-GPSLongitude',
      '-GPSAltitude', '-ColorSpace', '-BitDepth', '-MIMEType', '-Rotation', file], { timeout: 15000 });
    const data = JSON.parse(stdout)[0] || {};
    delete data.SourceFile;
    return data;
  } catch (err) {
    // The basic ffprobe/ImageMagick metadata remains available without ExifTool.
    return { scanNote: 'Extended metadata unavailable; install ExifTool and rescan.' };
  }
}
module.exports = { readMetadata };
