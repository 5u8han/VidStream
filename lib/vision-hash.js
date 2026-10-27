'use strict';
const { run } = require('./exec');

// dHash: shrink to 9x8 grayscale, compare each pixel to its right
// neighbor -> 64-bit fingerprint. Two images with a small Hamming
// distance between their hashes look visually similar (recompression,
// minor crop/rotation, a burst-shot near-duplicate); this needs no
// trained model, just ImageMagick's resize.
async function computeHash(imagePath, cfg) {
  if (!cfg.enableDuplicateDetection) return null;
  try {
    const { stdout } = await run(
      'convert',
      [imagePath, '-resize', '9x8!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'],
      { encoding: 'buffer' }
    );
    const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'binary');
    if (raw.length < 72) return null;
    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = raw[row * 9 + col];
        const right = raw[row * 9 + col + 1];
        hash = (hash << 1n) | (left < right ? 1n : 0n);
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) return Infinity;
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let count = 0;
  while (x) { count += Number(x & 1n); x >>= 1n; }
  return count;
}

module.exports = { computeHash, hammingDistance };
