'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function hashPassword(password){if(typeof password!=='string'||password.length<10||password.length>256)throw Error('Use a passphrase between 10 and 256 characters');const salt=crypto.randomBytes(16).toString('hex');return {salt,hash:(await scrypt(password,salt,64)).toString('hex')};}
async function verifyPassword(password,record){if(typeof password!=='string'||password.length>256||!record?.salt||!record?.hash)return false;return equal((await scrypt(password,record.salt,64)).toString('hex'),record.hash);}
function initializeSecurity(cfg){
 fs.mkdirSync(cfg.dataDir,{recursive:true});cfg.securityFile=path.join(cfg.dataDir,'security.json');
 try{const saved=JSON.parse(fs.readFileSync(cfg.securityFile,'utf8'));if(!saved.password?.hash||!saved.sessionSecret)throw Error('Invalid security settings');cfg.localPassword=saved.password;cfg.localUsername=saved.username;cfg.sessionSecret=saved.sessionSecret;cfg.requireLogin=saved.requireLogin!==false;}catch(e){if(e.code!=='ENOENT')throw e;}
 cfg.setupRequired=!(cfg.adminPassword||cfg.localPassword||(cfg.ldapUrl&&cfg.ldapBindDnTemplate));
 if(cfg.setupRequired){const file=path.join(cfg.dataDir,'owner-setup-code');try{cfg.setupCode=fs.readFileSync(file,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;cfg.setupCode=crypto.randomBytes(18).toString('hex');fs.writeFileSync(file,cfg.setupCode,{mode:0o600,flag:'wx'});}cfg.requireLogin=true;}
}
async function setupOwner(cfg,body){
 if(!cfg.setupRequired)throw Error('Owner setup is already complete');if(!equal(body.code,cfg.setupCode))throw Error('Incorrect owner setup code');
 const username=String(body.username||'owner').trim();if(!/^[a-zA-Z0-9._@-]{1,64}$/.test(username))throw Error('Use a simple username (letters, numbers, dots or dashes)');
 const password=await hashPassword(body.password),sessionSecret=crypto.randomBytes(32).toString('hex');
 // Exclusive creation prevents simultaneous first-time setup requests claiming ownership twice.
 const fd=fs.openSync(cfg.securityFile,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({username,password,sessionSecret,requireLogin:true}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 cfg.localUsername=username;cfg.localPassword=password;cfg.sessionSecret=sessionSecret;cfg.setupRequired=false;cfg.requireLogin=true;cfg.setupCode=null;
 fs.rmSync(path.join(cfg.dataDir,'owner-setup-code'),{force:true});
}
module.exports={initializeSecurity,setupOwner,hashPassword,verifyPassword};
