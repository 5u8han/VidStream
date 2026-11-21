'use strict';
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');

async function promptForPassphrase() {
  if (!process.stdin.isTTY) throw Error('Run this command in a terminal to enter the owner passphrase.');
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
  const interrupt = new AbortController();
  input.once('SIGINT', () => interrupt.abort());
  process.stderr.write('VidStream passphrase: ');
  try { return await input.question('', { signal: interrupt.signal }); }
  finally { input.close(); process.stderr.write('\n'); }
}

async function downloadRecovery() {
  const [address, directory = './vidstream-recovery', username] = process.argv.slice(2);
  if (!address || process.argv.length > 5)
    throw Error('Usage: node scripts/download-recovery.js <VidStream URL> [download directory] [LDAP username]');
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
    throw Error('Enter the HTTP or HTTPS address you use to open VidStream.');

  const origin = url.origin;
  const login = await fetch(origin + '/api/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: await promptForPassphrase() }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!login.ok) throw Error('VidStream sign-in failed (' + login.status + ').');
  const cookie = /^([\w-]+)=([A-Za-z0-9._-]+)(?:;|$)/.exec(login.headers.get('set-cookie') || '');
  if (!cookie) throw Error('VidStream did not return a sign-in cookie.');
  const manifest = await fetch(origin + '/api/notifications/recovery', {
    headers: { Cookie: cookie[0].replace(/;$/, '') }, redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!manifest.ok) throw Error('VidStream could not export the recovery list (' + manifest.status + ').');
  const data = await manifest.json();
  if (data.version !== 1 || !Array.isArray(data.items) ||
      data.items.some(item => !/^\/api\/notifications\/[a-f0-9]{16}\/source$/.test(item?.url)))
    throw Error('VidStream returned an invalid recovery list.');
  if (!data.items.length) { console.log('No unresolved media failures to download.'); return; }

  const destination = path.resolve(directory);
  await fs.mkdir(destination, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstream-recovery-'));
  try {
    const jar = path.join(temporary, 'cookies.txt');
    const addresses = path.join(temporary, 'urls.txt');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const secure = url.protocol === 'https:' ? 'TRUE' : 'FALSE';
    const expires = Math.floor(Number(cookie[2].split('.')[0]) / 1000);
    if (!Number.isSafeInteger(expires) || expires <= Date.now() / 1000)
      throw Error('VidStream returned an expired sign-in cookie.');
    const cookieLine = [hostname, 'FALSE', '/api/notifications/', secure, expires, cookie[1], cookie[2]].join('\t');
    await fs.writeFile(jar, '# Netscape HTTP Cookie File\n' + cookieLine + '\n', { mode: 0o600 });
    await fs.writeFile(addresses, data.items.map(item => origin + item.url).join('\n') + '\n', { mode: 0o600 });
    console.log('Downloading ' + data.items.length + ' original file(s) to ' + destination);
    const args = [
      '--no-config', '--no-proxy', '--no-hsts', '--max-redirect=0', '--tries=2', '--timeout=45',
      '--load-cookies', jar, '--input-file', addresses,
      '--no-directories', '--content-disposition',
    ];
    async function runDownloader(binary) {
      const child = spawn(binary, args, { cwd: destination, stdio: 'inherit' });
      const interrupt = () => child.kill('SIGINT');
      process.on('SIGINT', interrupt);
      try { return (await once(child, 'exit'))[0]; }
      finally { process.removeListener('SIGINT', interrupt); }
    }
    const exit = await runDownloader('wget').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return runDownloader('wget2');
    });
    if (exit !== 0) throw Error('One or more downloads did not finish (wget status ' + (exit ?? 'interrupted') + '). Check the output above.');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

downloadRecovery().catch(error => {
  console.error(error.code === 'ENOENT' ? 'Install GNU Wget or Wget2 and make sure it is on your PATH.' : error.message);
  process.exitCode = 1;
});
