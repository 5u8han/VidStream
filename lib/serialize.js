'use strict';
const crypto = require('crypto');
const path = require('path');

function srcset(id, kind, widths) {
  return widths.map((w) => `/media/${id}/${kind}?w=${w} ${w}w`).join(', ');
}

function publicItem(item, cfg, admin = false) {
  const isPhoto = item.type === 'photo';
  const thumbKind = isPhoto ? 'thumb' : 'poster';
  const thumbWidths = isPhoto ? cfg.thumbnailSizes : cfg.posterSizes;
  const largeWidths = cfg.largeSizes;

  const version = crypto.createHash("sha1").update(String(item.fingerprint || item.mtime || "")).digest("hex").slice(0, 12);
  const v = "v=" + version;
  const previewReady=item.processing?.previewReady!==false;
  const result = {
    favorite: item.favorite === true, pinned: item.pinned === true, bookmarked: item.bookmarked === true,
    id: item.id,
    mediaId: item.mediaId || item.id,
    sourceVersion: item.sourceVersion || null,
    activity: admin ? item.activity || null : null,
    type: item.type,
    availability: item.availability || 'available',
    processing: item.processing ? {...item.processing,error:admin?item.processing.error:undefined} : null,
    album: item.album,
    creator: item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)'),
    displayCreator: item.creatorAlias || item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)'),
    dateAdded: item.addedAt || null,
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
      path: admin ? path.join(cfg.mediaDir || "", item.relPath || item.filename) : null,
      birthtime: item.birthtime || null,
      metadata: admin ? item.metadata || {} : {},
      history: admin ? item.history || [] : [],
      ext: item.ext,
      size: item.size || null,
      mtime: item.mtime,
      addedAt: item.addedAt,
      album: item.album,
    creator: item.creator || (item.album ? item.album.split('/')[0] : '(Unsorted)'),
    dateAdded: item.addedAt || null,
      camera: item.camera || null,
      tech: item.tech || null,
    },
    urls: {
      thumb: `/media/${item.id}/${thumbKind}`,
      thumbSrcset: srcset(item.id, thumbKind, thumbWidths),
      original: `/media/${item.id}/original`,
      full: isPhoto && (item.isAnimated || !previewReady)
          ? `/media/${item.id}/original`
          : isPhoto
            ? `/media/${item.id}/large`
            : `/media/${item.id}/original`,
      fullSrcset: isPhoto && !item.isAnimated && previewReady ? srcset(item.id, 'large', largeWidths) : null,
      preview: item.type === 'video' && previewReady ? `/media/${item.id}/preview` : null,
      download: cfg.allowOriginalDownload ? `/media/${item.id}/original?download=1` : null,
    },
  };
  for (const key of ["thumb", "full", "original", "preview", "download"]) {
    if (result.urls[key]) result.urls[key] += (result.urls[key].includes("?") ? "&" : "?") + v;
  }
  for (const key of ["thumbSrcset", "fullSrcset"]) {
    if (result.urls[key]) result.urls[key] = result.urls[key].replace(/ (\d+)w/g, "&" + v + " $1w");
  }
  return result;
}

module.exports = { publicItem };
