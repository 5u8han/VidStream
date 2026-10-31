'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson, commitFile, verified, syncDir } = require('./durable-files');
const { jobMatches, sourceVersion } = require('./media-policy');

function inside(root, file) {
  return file.startsWith(root + path.sep);
}
async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
// Checking only the textual path would allow a replaced parent directory to
// redirect restore/publication outside the library. Resolve its parent too.
async function libraryPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative))
    throw Error('Invalid library path');
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw Error('Path is outside the library');
  const parent = await fs.realpath(path.dirname(file));
  if (parent !== root && !inside(root, parent))
    throw Error('Library path resolves outside the library');
  const resolved = path.join(parent, path.basename(file));
  try {
    if ((await fs.lstat(resolved)).isSymbolicLink())
      throw Error('Refusing a symbolic-link media destination');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}
async function commitNewFile(temp, target) {
  // link is an atomic, no-overwrite publication on the same filesystem. The
  // temporary file always lives beside the destination, including NAS mounts.
  const handle = await fs.open(temp, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.link(temp, target);
  await syncDir(path.dirname(target));
  await fs.unlink(temp);
}
async function verifiedCopy(source, temp, hash) {
  if (await exists(temp)) {
    const stat = await fs.lstat(temp);
    if (!stat.isFile() || !(await verified(temp, hash)))
      throw Error('An unverified temporary file requires manual review: ' + path.basename(temp));
    return;
  }
  await fs.copyFile(source, temp, require('node:fs').constants.COPYFILE_EXCL);
  if (!(await verified(temp, hash)))
    throw Error('Temporary copy failed verification; original retained');
}

class VariantService {
  constructor(cfg, db, queue, scanner) {
    Object.assign(this, { cfg, db, queue, scanner });
    this.busy = false;
  }
  archiveRoot() {
    return path.resolve(
      this.cfg.originalsDir || path.join(this.cfg.dataDir, 'originals', 'original')
    );
  }
  async validateArchive(record, journal, root, item) {
    if (!record || !/^[a-f0-9-]{36}$/i.test(record.id) || record.mediaId !== item.mediaId)
      throw Error('Publication journal identity does not match the media item');
    const archiveRoot = await fs.realpath(this.archiveRoot());
    if (archiveRoot === root || inside(root, archiveRoot))
      throw Error('Original archive must remain outside the library');
    const realJournal = await fs.realpath(journal),
      archive = await fs.realpath(record.archive);
    if (
      !inside(archiveRoot, realJournal) ||
      !inside(archiveRoot, archive) ||
      path.dirname(realJournal) !== path.dirname(archive)
    )
      throw Error('Publication journal/archive is outside its configured archive folder');
    if (!(await verified(archive, record.originalHash)))
      throw Error('Archived original failed verification');
    return archive;
  }
  async restoreMetadata(item, record, target, action) {
    if (item.relPath !== record.source) this.db.relocate(item, record.source);
    const original = record.item,
      stat = await fs.stat(target);
    Object.assign(item, {
      relPath: record.source,
      filename: original.filename,
      ext: original.ext,
      width: original.width,
      height: original.height,
      duration: original.duration,
      hasAudio: original.hasAudio,
      tech: original.tech,
      sourceVersion: record.originalHash,
      sourceHash: record.originalHash,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      fingerprint: '',
      availability: 'available',
      processing: { stage: 'pending', previewReady: false, analysisReady: false }
    });
    this.db.store.update(item, { activeVariant: null, lastPublication: null }, action);
    this.db.upsert(item);
  }
  async completed(item, id) {
    const job = this.queue.get(id);
    if (!job || job.itemId !== item.id || job.state !== 'completed' || job.options.preview)
      throw Error('Choose a completed full-video enhancement');
    if (!jobMatches(job, item))
      throw Error('The source changed after this job; generate a result for the current source');
    const file = path.join(this.queue.dir(id), 'enhanced.mp4');
    if (!(await verified(file, job.outputHash))) throw Error('Enhanced output failed verification');
    return { job, file };
  }
  async activate(item, id) {
    if (id === 'original') {
      this.db.store.update(item, { activeVariant: null }, 'original-selected');
      this.db.upsert(item);
      return;
    }
    const { job, file } = await this.completed(item, id);
    this.db.store.saveVariant(item, {
      id,
      kind: 'enhanced',
      path: file,
      url: '/api/enhancements/' + id + '/video',
      sourceVersion: sourceVersion(item),
      hash: job.outputHash,
      tech: {
        frameRate: job.options.fps,
        videoCodec: 'h264',
        audioCodec: job.verification?.audioTracks ? 'aac' : null
      },
      verification: job.verification,
      createdAt: job.completedAt
    });
    this.db.store.update(item, { activeVariant: id }, 'enhancement-approved');
    job.approvedAt = new Date().toISOString();
    this.queue.save(job);
    this.db.upsert(item);
  }
  async publish(item, id) {
    if (this.busy || this.scanner.scanning || this.scanner.editing)
      throw Error('Wait for the current scan/edit/publication to finish');
    this.busy = this.scanner.editing = true;
    try {
      const { job, file } = await this.completed(item, id);
      const root = await fs.realpath(this.cfg.mediaDir),
        source = await libraryPath(root, item.relPath);
      if (!(await verified(source, job.sourceHash)))
        throw Error('Source bytes changed; original will not be replaced');
      const archiveRoot = this.archiveRoot();
      if (archiveRoot === root || archiveRoot.startsWith(root + path.sep))
        throw Error('Original archive must be outside the media library');
      await fs.mkdir(archiveRoot, { recursive: true });
      const realArchiveRoot = await fs.realpath(archiveRoot);
      if (realArchiveRoot === root || realArchiveRoot.startsWith(root + path.sep))
        throw Error('Original archive must resolve outside the media library');
      const token = crypto.randomUUID(),
        dir = path.join(realArchiveRoot, item.mediaId || item.id, token);
      await fs.mkdir(dir, { recursive: true });
      if (!(await fs.realpath(dir)).startsWith(realArchiveRoot + path.sep))
        throw Error('Archive path contains an external symlink');
      const archive = path.join(dir, 'original' + path.extname(item.filename));
      const targetRel = path.join(
        path.dirname(item.relPath),
        path.parse(item.filename).name + '.mp4'
      );
      const target = await libraryPath(root, targetRel);
      if (target !== source && (await exists(target)))
        throw Error('A different file already uses the MP4 destination name');
      const record = {
        id: token,
        mediaId: item.mediaId,
        jobId: id,
        source: item.relPath,
        target: targetRel,
        originalHash: job.sourceHash,
        outputHash: job.outputHash,
        state: 'prepared',
        item: { ...item },
        archive
      };
      await fs.copyFile(source, archive, require('node:fs').constants.COPYFILE_EXCL);
      const handle = await fs.open(archive, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await verified(archive, job.sourceHash)))
        throw Error('Original archive verification failed');
      await atomicJson(path.join(dir, 'publication.json'), record);
      const temp = path.join(path.dirname(target), '.vidstream-publish-' + token + '.mp4');
      await verifiedCopy(file, temp, job.outputHash);
      if (!(await verified(temp, job.outputHash)) || !(await verified(source, job.sourceHash)))
        throw Error('A file changed during publication; journal and original retained');
      if (target === source) await commitFile(temp, target);
      else await commitNewFile(temp, target);
      record.state = 'published';
      await atomicJson(path.join(dir, 'publication.json'), record);
      if (source !== target) {
        if (!(await verified(source, job.sourceHash)))
          throw Error('Original changed after publication; retained both paths for recovery');
        await fs.unlink(source);
      }
      if (targetRel !== item.relPath) this.db.relocate(item, targetRel);
      const publishedStat = await fs.stat(target);
      Object.assign(item, {
        filename: path.basename(targetRel),
        ext: '.mp4',
        sourceHash: job.outputHash,
        sourceVersion: job.outputHash,
        fingerprint: '',
        mtime: publishedStat.mtime.toISOString(),
        size: publishedStat.size,
        processing: { stage: 'pending', previewReady: false, analysisReady: false },
        width: job.verification?.width || item.width,
        height: job.verification?.height || item.height,
        tech: {
          ...item.tech,
          frameRate: job.options.fps,
          previewFrameRate: null,
          videoCodec: 'h264',
          audioCodec: job.verification?.audioTracks ? 'aac' : null,
          pixelFormat: 'yuv420p',
          bitDepth: 8,
          frameRateMode: 'constant'
        }
      });
      this.db.store.update(
        item,
        {
          activeVariant: null,
          lastPublication: { id: token, journal: path.join(dir, 'publication.json') }
        },
        'enhancement-published'
      );
      this.db.upsert(item);
      record.state = 'committed';
      await atomicJson(path.join(dir, 'publication.json'), record);
      return {
        published: true,
        archive,
        note: 'Enhanced video published; verified original and recovery journal are retained outside media.'
      };
    } finally {
      this.busy = this.scanner.editing = false;
    }
  }
  async restore(item) {
    if (this.busy || this.scanner.scanning || this.scanner.editing)
      throw Error('Wait for active scanning/editing to finish');
    if (!item.lastPublication?.journal)
      throw Error('No publication journal is linked to this item');
    this.busy = this.scanner.editing = true;
    try {
      const journal = item.lastPublication.journal,
        record = JSON.parse(await fs.readFile(journal, 'utf8'));
      const root = await fs.realpath(this.cfg.mediaDir),
        current = await libraryPath(root, record.target),
        target = await libraryPath(root, record.source);
      const archive = await this.validateArchive(record, journal, root, item);
      if (!(await verified(current, record.outputHash)))
        throw Error('Published file or archive changed; manual recovery required');
      if (target !== current && (await exists(target)))
        throw Error('Original destination already exists; refusing to overwrite');
      record.state = 'restoring';
      await atomicJson(journal, record);
      const temp = path.join(
        path.dirname(target),
        '.vidstream-restore-' + record.id + path.extname(target)
      );
      await verifiedCopy(archive, temp, record.originalHash);
      if (!(await verified(current, record.outputHash)))
        throw Error('Published file changed during restore; original archive retained');
      if (target === current) await commitFile(temp, target);
      else await commitNewFile(temp, target);
      if (current !== target) {
        if (!(await verified(current, record.outputHash)))
          throw Error(
            'Published file changed during restore; retained both paths for manual recovery'
          );
        await fs.unlink(current);
        await syncDir(path.dirname(current));
      }
      await this.restoreMetadata(item, record, target, 'original-restored');
      record.state = 'restored';
      await atomicJson(journal, record);
      return { restored: true, note: 'Original restored; archived copy remains available.' };
    } finally {
      this.busy = this.scanner.editing = false;
    }
  }
  async recoverPending() {
    if (this.busy || this.scanner.scanning || this.scanner.editing)
      throw Error('Wait for scanning/editing to finish before recovery');
    this.busy = this.scanner.editing = true;
    const issues = [];
    let recovered = 0;
    try {
      const root = await fs.realpath(this.cfg.mediaDir),
        archiveRoot = this.archiveRoot();
      let mediaDirs = [];
      try {
        mediaDirs = await fs.readdir(archiveRoot, { withFileTypes: true });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      for (const mediaDir of mediaDirs.filter((d) => d.isDirectory()))
        for (const folder of await fs.readdir(path.join(archiveRoot, mediaDir.name), {
          withFileTypes: true
        })) {
          if (!folder.isDirectory()) continue;
          const journal = path.join(archiveRoot, mediaDir.name, folder.name, 'publication.json');
          let record;
          try {
            record = JSON.parse(await fs.readFile(journal, 'utf8'));
          } catch (e) {
            if (e.code !== 'ENOENT') issues.push({ id: folder.name, error: e.message });
            continue;
          }
          if (!['prepared', 'published', 'restoring'].includes(record.state)) continue;
          try {
            const item = this.db.get(record.mediaId);
            if (!item)
              throw Error('Catalog item missing; original archive retained for manual relink');
            const target = await libraryPath(root, record.source),
              published = await libraryPath(root, record.target);
            const realArchive = await this.validateArchive(record, journal, root, item);
            const originalPresent = await verified(target, record.originalHash),
              outputPresent = await verified(published, record.outputHash);
            if (!originalPresent) {
              if (target !== published) {
                if (await exists(target))
                  throw Error('An unrelated file occupies the original path');
              } else if (!outputPresent)
                throw Error(
                  'Current file differs from both known versions; automatic recovery refused'
                );
              const temp = path.join(
                path.dirname(target),
                '.vidstream-recover-' + record.id + path.extname(target)
              );
              await verifiedCopy(realArchive, temp, record.originalHash);
              if (target === published) {
                if (!(await verified(published, record.outputHash)))
                  throw Error('Published file changed during recovery');
                await commitFile(temp, target);
              } else await commitNewFile(temp, target);
            }
            if (published !== target && outputPresent) {
              if (!(await verified(published, record.outputHash)))
                throw Error('Published file changed during recovery; retained both paths');
              await fs.unlink(published);
              await syncDir(path.dirname(published));
            }
            await this.restoreMetadata(item, record, target, 'publication-recovered');
            record.state = 'recovered-original';
            await atomicJson(journal, record);
            recovered++;
          } catch (e) {
            issues.push({ id: record.id || folder.name, error: e.message });
          }
        }
      return {
        recovered,
        issues,
        note: 'Verified interrupted operations were rolled back to their archived originals. Ambiguous files were retained for manual recovery.'
      };
    } finally {
      this.busy = this.scanner.editing = false;
    }
  }
}
module.exports = { VariantService };
