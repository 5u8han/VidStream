'use strict';
const { run } = require('./exec');

// Returns extracted text (trimmed, whitespace-collapsed) or '' if OCR
// is disabled, tesseract isn't installed, or no text was found.
async function extractText(imagePath, cfg) {
  if (!cfg.enableOcr) return '';
  try {
    const { stdout } = await run('tesseract', [imagePath, 'stdout'], { maxBuffer: 1024 * 1024 * 8 });
    return stdout.replace(/\s+/g, ' ').trim();
  } catch {
    // tesseract not installed on this host, or it choked on this file
    // -- OCR is a best-effort enhancement, never a hard dependency.
    return '';
  }
}

module.exports = { extractText };
