'use strict';

function srcset(id, kind, widths) {
  return widths.map((w) => `/media/${id}/${kind}?w=${w} ${w}w`).join(', ');
}

function publicItem(item, cfg) {
  const isPhoto = item.type === 'photo';
  const thumbKind = isPhoto ? 'thumb' : 'poster';
  const thumbWidths = isPhoto ? cfg.thumbnailSizes : cfg.posterSizes;
  const largeWidths = cfg.largeSizes;

  return {
    id: item.id,
    type: item.type,
    album: item.album,
    filename: item.filename,
    width: item.width,
    height: item.height,
    color: item.color,
    date: item.dateTaken || item.mtime,
    dateExact: Boolean(item.dateTaken),
    isAnimated: item.isAnimated,
    duration: item.duration,
    hasAudio: item.hasAudio,
    guest: item.guest === true,
    hasFace: item.hasFace === true,
    faceCount: item.faceCount || 0,
    hasCat: item.hasCat === true,
    hasText: item.hasText === true,
    objects: Array.isArray(item.objects) ? item.objects : [],
    ocrText: item.ocrText || '',
    info: {
      filename: item.filename,
      ext: item.ext,
      size: item.size || null,
      mtime: item.mtime,
      addedAt: item.addedAt,
      album: item.album,
      camera: item.camera || null,
      tech: item.tech || null,
    },
    urls: {
      thumb: `/media/${item.id}/${thumbKind}`,
      thumbSrcset: srcset(item.id, thumbKind, thumbWidths),
      full:
        isPhoto && item.isAnimated
          ? `/media/${item.id}/original`
          : isPhoto
            ? `/media/${item.id}/large`
            : `/media/${item.id}/original`,
      fullSrcset: isPhoto && !item.isAnimated ? srcset(item.id, 'large', largeWidths) : null,
      preview: item.type === 'video' ? `/media/${item.id}/preview` : null,
      download: cfg.allowOriginalDownload ? `/media/${item.id}/original?download=1` : null,
    },
  };
}

module.exports = { publicItem };
