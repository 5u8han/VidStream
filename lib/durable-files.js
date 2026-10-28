'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
async function syncDir(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function commitFile(temp, dest) {
  const handle = await fs.open(temp, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, dest);
  await syncDir(path.dirname(dest));
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const temp=file+'.tmp';
  await fs.writeFile(temp,JSON.stringify(value));
  await commitFile(temp,file);
}
async function digest(file) {
  const hash=crypto.createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
async function verified(file, hash) {
  if (!hash) return false;
  try { return await digest(file) === hash; } catch { return false; }
}
module.exports={atomicJson,commitFile,digest,verified,syncDir};
