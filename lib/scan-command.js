'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');

const scanCommands = new AsyncLocalStorage();

function runScanCommand(scope, cmd, args, opts) {
  const { signal, progress } = scope;
  signal.throwIfAborted();
  progress(cmd);
  const timeout = opts.timeout ?? 60_000;
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 ** 2;
  const encoding = opts.encoding === 'buffer' ? null : opts.encoding || 'utf8';
  const group = process.platform !== 'win32';
  const child = spawn(cmd, args, {
    cwd: opts.cwd, env: opts.env, detached: group, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let failure;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (child.pid) {
        try {
          if (group) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (signalError) {
          if (signalError.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = timeout > 0 ? setTimeout(() => stop(Object.assign(
      Error(cmd + ' exceeded its ' + Math.ceil(timeout / 1000) + '-second time limit'),
      { code: 'SCAN_TASK_TIMEOUT', killed: true })), timeout) : null;
    function capture(stream) {
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBuffer) stop(Error(cmd + ' exceeded its output limit'));
        else chunks.push(chunk);
      });
      return () => {
        const value = Buffer.concat(chunks);
        return encoding ? value.toString(encoding) : value;
      };
    }
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, childSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) progress();
      if (!failure && (code !== 0 || childSignal))
        failure = Object.assign(Error(cmd + ' failed (' + (childSignal || 'exit ' + code) + ')'), { stderr: stderr() });
      if (failure) reject(failure);
      else resolve({ stdout: stdout(), stderr: stderr() });
    });
  });
}

module.exports = { scanCommands, runScanCommand };
