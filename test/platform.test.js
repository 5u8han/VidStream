'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {initializeSecurity,setupOwner,verifyPassword}=require('../lib/security');
const {getRole,checkCredentials,setSessionCookie}=require('../lib/auth');
const {ioCounters,networkCounters,pairs,ResourceMonitor}=require('../lib/resource-monitor');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidstream14-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('unconfigured server requires owner setup; hashed passphrase survives restart and logout stays anonymous',async t=>{
 const dataDir=directory(t),cfg={dataDir,sessionSecret:'old-secret'};initializeSecurity(cfg);assert.equal(cfg.setupRequired,true);assert.equal(getRole({headers:{}},cfg),'anonymous');
 await assert.rejects(setupOwner(cfg,{code:'bad',password:'a long test password'}),/Incorrect/);
 await setupOwner(cfg,{code:cfg.setupCode,password:'a long test password',username:'owner'});assert.equal(cfg.requireLogin,true);
 assert.equal(await checkCredentials('owner','wrong password',cfg),false);assert.equal(await checkCredentials('owner','a long test password',cfg),true);
 assert.equal(fs.readFileSync(cfg.securityFile,'utf8').includes('a long test password'),false);
 let cookie;setSessionCookie({setHeader(k,v){cookie=v;}},cfg,{headers:{}});assert.equal(getRole({headers:{cookie:cookie.split(';')[0]}},cfg),'admin');assert.equal(getRole({headers:{}},cfg),'anonymous');
 const again={dataDir};initializeSecurity(again);assert.equal(await checkCredentials('owner','a long test password',again),true);assert.equal(again.setupRequired,false);
 await assert.rejects(setupOwner(again,{password:'another password'}),/already complete/);assert.equal(await verifyPassword('x'.repeat(300),again.localPassword),false);
});
test('configured password and LDAP retain their existing authentication paths',t=>{
 const dataDir=directory(t);for(const extra of [{adminPassword:'existing-password'},{ldapUrl:'ldap://internal',ldapBindDnTemplate:'uid={username},dc=example'}]){const cfg={dataDir,...extra};initializeSecurity(cfg);assert.equal(cfg.setupRequired,false);assert.equal(getRole({headers:{}},cfg),'anonymous');}
});
test('resource parsers distinguish bytes, network totals and unavailable counters',()=>{
 assert.deepEqual(ioCounters('8:0 rbytes=1234 wbytes=5678 rios=1\n8:1 rbytes=10 wbytes=20'),{read:1244,write:5698});assert.equal(ioCounters(null),null);
 assert.deepEqual(networkCounters('lo: 999 0 0 0 0 0 0 0 999 0\neth0: 123 0 0 0 0 0 0 0 456 0'),{received:123,sent:456});
 assert.equal(pairs('MemAvailable: 12345 kB').MemAvailable,12345);
});
test('resource sampling caches polling and preserves observed byte totals',async t=>{
 const dir=directory(t),settings=new Map(),store={setting:(k,d)=>settings.has(k)?settings.get(k):d,setSetting:(k,v)=>settings.set(k,v)};
 const monitor=new ResourceMonitor({dataDir:dir},store);const a=await monitor.sample(),b=await monitor.sample();assert.equal(a.at,b.at);assert.ok(a.memory.workloadUsedBytes>0);assert.ok(a.disk.availableBytes>0);assert.equal(a.cpu.workloadPercent,null);
 monitor.cached=null;await delay(20);const c=await monitor.sample();assert.ok(c.totals.cpuSeconds>=0);assert.ok(settings.has('resourceTotals'));monitor.stop();
});
