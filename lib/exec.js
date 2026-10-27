'use strict';
const { execFile } = require('child_process');

// Runs an external tool and resolves with {stdout, stderr}. Rejects only
// on a genuine non-zero exit -- tools like `identify` print warnings to
// stderr (e.g. "unknown image property") on exit code 0 when an EXIF
// tag is simply absent, and callers need to treat that as "no data",
// not as failure.
//
// Every call gets a timeout (default 60s, override via opts.timeout).
// A hung subprocess -- a malformed file that makes ffmpeg or OpenCV
// spin, a stalled network mount -- previously stayed alive
// indefinitely, permanently occupying a processing-queue slot and
// leaking OS-level memory that Node's own heap metrics never show.
// Node's execFile enforces this itself (SIGTERM on expiry); we don't
// need to implement the kill logic by hand.
function run(cmd, args, opts = {}) {
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

module.exports = { run };

