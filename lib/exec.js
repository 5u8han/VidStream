'use strict';
const { execFile, spawnSync } = require('node:child_process');
const { scanCommands, runScanCommand } = require('./scan-command');

function run(cmd, args, opts = {}) {
  const scope = scanCommands.getStore();
  if (scope) return runScanCommand(scope, cmd, args, opts);
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 64, timeout: 60_000, ...opts },
      (err, stdout, stderr) => {
        if (err && err.code !== 0) {
          const e = new Error(
            err.killed ? `${cmd} timed out and was killed` : `${cmd} failed: ${err.message}`
          );
          e.stderr = stderr;
          e.cmd = cmd;
          e.args = args;
          e.killed = err.killed === true;
          reject(e);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

let imageMagick;
const IMAGE_COMMANDS = ['magick', 'convert'];

function imageTool(command, stdout) {
  const version = stdout?.split('\n')[0].trim();
  return version?.startsWith('Version: ImageMagick ') ? { command, version } : null;
}

function findImageMagick() {
  if (imageMagick !== undefined) return imageMagick;
  for (const command of IMAGE_COMMANDS) {
    const result = spawnSync(command, ['-version'], { encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL', windowsHide: true });
    if (result.status === 0 && (imageMagick = imageTool(command, result.stdout))) return imageMagick;
  }
  imageMagick = null;
  return imageMagick;
}

async function runImageMagick(args, opts) {
  if (imageMagick === undefined) {
    let available;
    for (const command of IMAGE_COMMANDS) {
      try {
        const { stdout } = await run(command, ['-version'], { timeout: 3_000, maxBuffer: 256 * 1024 });
        available = imageTool(command, stdout);
        if (available) break;
      } catch (error) {
        scanCommands.getStore()?.signal.throwIfAborted();
        if (error.killed) throw error;
      }
    }
    imageMagick ??= available || null;
  }
  if (!imageMagick) throw new Error('ImageMagick is required. Install magick (7) or convert (6) on PATH.');
  return run(imageMagick.command, args, opts);
}

module.exports = { run, findImageMagick, runImageMagick };

