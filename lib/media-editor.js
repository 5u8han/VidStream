'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./exec');

function validateEdit(item, body) {
  const width = item.width, height = item.height;
  if (!(width > 0 && height > 0)) throw Error('Media dimensions are unavailable');
  const n = (key, fallback) => {
    const value = body[key] === undefined || body[key] === '' ? fallback : Number(body[key]);
    if (!Number.isFinite(value)) throw Error('Invalid ' + key);
    return value;
  };
  const x = n('x', 0), y = n('y', 0), w = n('width', width), h = n('height', height);
  if (![x,y,w,h].every(Number.isInteger) || x < 0 || y < 0 || w < 2 || h < 2 || x+w > width || y+h > height) throw Error('Crop must fit within the displayed source dimensions');
  const maxWidth = n('maxWidth', w);
  if (!Number.isInteger(maxWidth) || maxWidth < 2 || maxWidth > w) throw Error('Output width must be between 2 and the crop width');
  const start = n('start', 0), end = n('end', item.duration || 0);
  if (item.type === 'video' && (start < 0 || end <= start || end > item.duration + 0.01)) throw Error('Choose a valid start and end within the video');
  if (item.isAnimated) throw Error('Animated image editing is not supported in this beta');
  if (!(item.type === 'photo' ? ['.jpg','.jpeg','.png','.webp'] : ['.mp4','.m4v','.mov','.mkv','.webm']).includes(item.ext)) throw Error('This format is not supported for editing in this beta');
  return { x,y,width:w,height:h,maxWidth,start,end };
}
class MediaEditor {
  constructor(cfg, db, scanner) { Object.assign(this, {cfg,db,scanner}); this.busy = false; }
  async edit(item, body) {
    if (this.busy || this.scanner.scanning) throw Error('A scan or edit is in progress. Try again when it finishes.');
    const spec = validateEdit(item, body);
    this.busy = this.scanner.editing = true;
    let temp;
    try {
      const root = await fs.realpath(this.cfg.mediaDir);
      const source = await fs.realpath(path.join(root, item.relPath));
      if (!source.startsWith(root + path.sep)) throw Error('Media must be inside the library');
      const before = await fs.stat(source);
      const revision = crypto.randomUUID();
      const archiveRoot = path.join(root, '.vidstream-originals');
      await fs.mkdir(archiveRoot, {recursive:true});
      if ((await fs.lstat(archiveRoot)).isSymbolicLink()) throw Error('Archive directory must not be a symbolic link');
      const archive = path.join(archiveRoot, revision);
      await fs.mkdir(archive);
      if (!(await fs.realpath(archive)).startsWith(root + path.sep)) throw Error('Archive must be inside the library');
      temp = path.join(archive, 'edited' + item.ext);
      if (item.type === 'photo') {
        await run('convert', [source + '[0]', '-auto-orient', '-crop', `${spec.width}x${spec.height}+${spec.x}+${spec.y}`, '+repage', '-resize', `${spec.maxWidth}x>`, temp], { timeout: 120000 });
      } else {
        const filters = `crop=${spec.width}:${spec.height}:${spec.x}:${spec.y},scale=${Math.floor(spec.maxWidth/2)*2}:-2,setsar=1`;
        const codec = item.ext === '.webm' ? ['-c:v','libvpx-vp9','-c:a','libopus'] : ['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac'];
        await run('ffmpeg', ['-y','-i',source,'-ss',String(spec.start),'-t',String(spec.end-spec.start),'-map','0:v:0','-map','0:a?','-vf',filters,...codec,'-map_metadata','0',temp,'-loglevel','error'], { timeout: 900000 });
      }
      if ((await fs.stat(temp)).size === 0) throw Error('Edit output is empty');
      const after = await fs.stat(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Error('Source changed during editing; retry after scanning');
      const backup = path.join(archive, 'original' + item.ext);
      await fs.copyFile(source, backup, require('node:fs').constants.COPYFILE_EXCL);
      // A journal is written before atomic replacement, so a power loss always
      // leaves a discoverable original and recovery instructions.
      await fs.writeFile(path.join(archive, 'revision.json'), JSON.stringify({ relPath:item.relPath, spec, at:new Date().toISOString() }, null, 2));
      this.db.store.record(item, 'edit-prepared', { revision, backup:path.relative(root,backup), spec });
      await fs.chmod(temp, before.mode & 0o777);
      for (const file of [backup, temp]) { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
      await fs.rename(temp, source);
      temp = null;
      this.db.store.record(item, 'edited', { revision, backup:path.relative(root,backup), spec });
      // Invalidate the index even if subsequent preview generation fails.
      item.fingerprint = '';
      this.db._saveNow();
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
      this.busy = this.scanner.editing = false;
    }
    const result = await this.scanner.scan();
    if (this.scanner.failed.some((f) => f.relPath === item.relPath)) {
      return { saved:true, warning:'Edit saved with original archived. Preview generation failed; check the dashboard and rescan.', result };
    }
    return { saved:true, result };
  }
}
module.exports = { MediaEditor, validateEdit };
