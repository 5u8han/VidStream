'use strict';
const { run } = require('./exec');

async function extractText(imagePath, cfg) {
  if (!cfg.enableOcr) return '';
  try {
    const { stdout } = await run('tesseract', [imagePath, 'stdout'], { maxBuffer: 1024 * 1024 * 8 });
    return stdout.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

module.exports = { extractText };
