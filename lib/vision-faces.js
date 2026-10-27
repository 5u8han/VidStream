'use strict';
const path = require('path');
const { run } = require('./exec');

const SCRIPT = path.join(__dirname, 'vision', 'detect.py');

async function detectFacesAndCats(imagePath, cfg) {
  const fallback = { faceCount: 0, hasFace: false, hasCat: false };
  if (!cfg.enableFaceDetection && !cfg.enablePetDetection) return fallback;
  try {
    const { stdout } = await run('python3', [SCRIPT, imagePath]);
    const result = JSON.parse(stdout.trim());
    if (result.error) return fallback;
    return {
      faceCount: cfg.enableFaceDetection ? result.faceCount : 0,
      hasFace: cfg.enableFaceDetection ? result.hasFace : false,
      hasCat: cfg.enablePetDetection ? result.hasCat : false,
    };
  } catch {
    // python3/opencv unavailable on this host, or the script failed --
    // detection is a best-effort enhancement, never a hard dependency.
    return fallback;
  }
}

module.exports = { detectFacesAndCats };
