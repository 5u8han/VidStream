'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { loadConfig } = require('../lib/config');
const { Db } = require('../lib/db');
const { Scanner } = require('../lib/scanner');
const { WorkCoordinator } = require('../lib/work-coordinator');

async function waitFor(check, description) {
  const until = Date.now() + 30_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(40);
  } while (Date.now() < until);
  throw Error('Timed out waiting for ' + description);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstream-scan-test-'));
  const media = path.join(root, 'media');
  const overrides = path.join(root, 'tools');
  const first = 'First';
  const next = 'Next';
  const issues = [];
  let scanner, db, coordinator;
  try {
    for (const folder of [path.join(media, first), path.join(media, next), overrides])
      await fs.mkdir(folder, { recursive: true });
    const tool = execFileSync('sh', ['-c', 'command -v magick || command -v convert'], { encoding: 'utf8' }).trim();
    const original = path.join(media, first, 'manual.png');
    execFileSync(tool, ['-size', '12x8', 'xc:navy', original]);
    const pixels = await fs.readFile(original);
    await fs.copyFile(original, path.join(media, first, 'timeout.png'));
    await fs.copyFile(original, path.join(media, first, 'healthy.png'));
    await fs.copyFile(original, path.join(media, next, 'next.png'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=blue:s=96x64:r=10:d=1', '-c:v', 'mpeg4', path.join(media, next, 'movie.mp4')]);
    Object.assign(process.env, {
      PATH: overrides + path.delimiter + process.env.PATH, VIDSTREAM_TEST_CONVERTER: tool,
      VIDSTREAM_TEST_NODE: process.execPath, VIDSTREAM_TEST_DIR: root,
      MEDIA_DIR: media, DATA_DIR: path.join(root, 'data'), CACHE_DIR: path.join(root, 'cache'),
      PROCESSING_CONCURRENCY: '1', SCAN_READ_CONCURRENCY: '1', MEDIA_FOLDER_MODE: 'manual',
      ENABLE_FACE_DETECTION: '0', ENABLE_PET_DETECTION: '0', ENABLE_OCR: '0',
      ENABLE_DUPLICATE_DETECTION: '0', ENABLE_OBJECT_DETECTION: '0',
    });
    await fs.writeFile(path.join(overrides, 'magick'), `#!/bin/sh
case "$1" in
  */manual.png*|*/timeout.png*)
    if test -f "$VIDSTREAM_TEST_DIR/stall"; then
      exec "$VIDSTREAM_TEST_NODE" -e 'process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(process.env.VIDSTREAM_TEST_DIR+"/"+require("node:path").basename(process.argv[1]).split(".")[0]+".pid",String(process.pid)); setTimeout(()=>process.exit(1),60000)' "$1"
    fi ;;
esac
exec "$VIDSTREAM_TEST_CONVERTER" "$@"
`, { mode: 0o700 });
    await fs.writeFile(path.join(root, 'stall'), '');
    const cfg = loadConfig(root);
    const open = () => new Db(path.join(cfg.cacheDir, 'index.json'), cfg.dataDir, { mediaFolders: [first, next] });
    db = open();
    coordinator = new WorkCoordinator(db.store, { scanWorkers: 1 });
    scanner = new Scanner(cfg, db, { stageTimeout: 3000, coordinator, onIssue: issue => issues.push(issue) });
    assert(scanner.startScan({ folder: first }).started);
    assert(scanner.startScan({ folder: next }).queued);
    const manual = await waitFor(async () => {
      if (!await fs.stat(path.join(root, 'manual.pid')).catch(() => null)) return;
      return [...scanner.active.values()].find(task => task.skippable && task.path === first + '/manual.png');
    }, 'the deliberately stalled poster');
    assert(scanner.skipActiveFile(manual.id));
    await waitFor(() => !scanner.scanning && !scanner.pending.size, 'both folder scans to finish');
    for (const filename of ['manual.png', 'timeout.png']) {
      const rel = first + '/' + filename;
      assert(issues.some(issue => issue.code === 'SCAN_FILE_FAILED' && issue.path === rel), rel);
      assert.deepEqual(await fs.readFile(path.join(media, rel)), pixels);
      const pid = Number(await fs.readFile(path.join(root, filename.split('.')[0] + '.pid'), 'utf8'));
      await waitFor(() => { try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') return true; throw err; } },
        'the stalled converter to exit');
    }
    assert.equal(scanner.reports.get(first).failed, 2);
    assert.equal(scanner.reports.get(next).status, 'success');
    assert.equal(scanner.skipActiveFile(manual.id), false);
    const healthy = db.findByRelPath(first + '/healthy.png');
    assert.equal(healthy.processing.stage, 'ready');
    await fs.unlink(path.join(root, 'stall'));
    await scanner.repair(first + '/manual.png');
    db.store.close();
    db = open();
    assert.equal(db.findByRelPath(first + '/manual.png').processing.stage, 'ready');
    assert.equal(db.findByRelPath(first + '/healthy.png').mediaId, healthy.mediaId);
    assert.equal(db.findByRelPath(next + '/next.png').processing.stage, 'ready');
    assert.equal(db.findByRelPath(next + '/movie.mp4').processing.stage, 'ready');
    console.log('Manual skip, automatic timeout, subsequent folder, converter cleanup, retry, and catalog reopen passed.');
  } finally {
    scanner?.stopWatching();
    await coordinator?.stop();
    await scanner?.waitForIdle();
    db?.store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
