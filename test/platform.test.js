'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {initializeSecurity,setupOwner,verifyPassword}=require('../lib/security');
const {getRole,checkCredentials,setSessionCookie}=require('../lib/auth');
const {Db}=require('../lib/db');
const {CleanLibrary}=require('../lib/clean-library');
const {EnhancementQueue}=require('../lib/enhancement-queue');
const {ioCounters,networkCounters,pairs,ResourceMonitor}=require('../lib/resource-monitor');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidstream14-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
async function finish(exporter){for(let i=0;i<300&&exporter.active;i++)await delay(10);assert.equal(exporter.active,false);}
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
test('clean export preserves sources, resumes verified files, and refuses unrelated overwrite',async t=>{
 const dir=directory(t),cfg={dataDir:path.join(dir,'data'),mediaDir:path.join(dir,'media')};fs.mkdirSync(cfg.mediaDir);fs.writeFileSync(path.join(cfg.mediaDir,'photo.jpg'),'original photo');fs.writeFileSync(path.join(cfg.mediaDir,'clip.mp4'),'original clip');
 const db=new Db(path.join(dir,'cache','index.json'),cfg.dataDir);t.after(()=>{clearTimeout(db._saveTimer);db.store.close();});
 db.upsert({id:'photo',filename:'photo.jpg',relPath:'photo.jpg',type:'photo',fingerprint:'p'});db.upsert({id:'clip',filename:'clip.mp4',relPath:'clip.mp4',type:'video',fingerprint:'v'});
 const queue=new EnhancementQueue(cfg,db),id=crypto.randomUUID();fs.mkdirSync(queue.dir(id),{recursive:true});const output=path.join(queue.dir(id),'enhanced.mp4');fs.writeFileSync(output,'enhanced clip');
 const exporter=new CleanLibrary(cfg,db,queue);await exporter.start(true);await finish(exporter);assert.equal(fs.readFileSync(path.join(exporter.root,'clip.mp4'),'utf8'),'original clip');
 db.store.saveJob({id,itemId:'clip',relPath:'clip.mp4',sourceFingerprint:'v',state:'completed',outputHash:crypto.createHash('sha256').update('enhanced clip').digest('hex')});
 await exporter.start(true);await finish(exporter);assert.equal(exporter.status().state,'completed',exporter.status().error);assert.equal(exporter.status().done,2);
 assert.equal(fs.existsSync(path.join(exporter.root,'clip.mp4')),false);const manifest=JSON.parse(fs.readFileSync(path.join(exporter.root,'manifest.json'),'utf8'));assert.equal(fs.readFileSync(path.join(exporter.root,manifest.archives[0].archivedAs),'utf8'),'original clip');
 const photo=path.join(exporter.root,'photo.jpg'),before=fs.statSync(photo).mtimeMs;assert.equal(fs.readFileSync(path.join(exporter.root,'clip--'+id+'.mp4'),'utf8'),'enhanced clip');
 await exporter.start(true);await finish(exporter);assert.equal(fs.statSync(photo).mtimeMs,before);assert.equal(fs.readFileSync(path.join(cfg.mediaDir,'clip.mp4'),'utf8'),'original clip');
 fs.writeFileSync(photo,'unrelated edit');await exporter.start(true);await finish(exporter);assert.equal(exporter.status().state,'paused');assert.match(exporter.status().error,/Refusing to overwrite/);assert.equal(fs.readFileSync(photo,'utf8'),'unrelated edit');
});
test('server-wide enhancement disable prevents new jobs without deleting saved work',async t=>{
 const dir=directory(t),db=new Db(path.join(dir,'index.json'),path.join(dir,'data'));t.after(()=>db.store.close());const queue=new EnhancementQueue({dataDir:path.join(dir,'data')},db);db.store.setSetting('enhancementEnabled',false);
 await assert.rejects(queue.create({type:'video'},{}),/Enable enhancement/);await queue.tick();assert.equal(queue.active,null);
});
test('large batches page jobs without rereading every job for worker lookups',t=>{
 const root=directory(t),db=new Db(path.join(root,'index.json'),path.join(root,'data'));t.after(()=>db.store.close());
 for(let i=0;i<120;i++)db.store.saveJob({id:'job-'+i,itemId:'item-'+i,sourceFingerprint:'v1',options:{smoothing:'ffmpeg'},state:i===10?'queued':'completed'});
 const page=db.store.jobPage();assert.equal(page.jobs.length,50);assert.equal(page.total,120);assert.equal(page.nextOffset,50);assert.equal(db.store.jobPage(null,100).jobs.length,20);
 assert.equal(db.store.nextJob().id,'job-10');assert.equal(db.store.job('job-7').itemId,'item-7');assert.equal(db.store.matchingJob({id:'item-7',fingerprint:'v1'},{smoothing:'ffmpeg'}).id,'job-7');
});
test('global suspension retains queued work while respecting an explicit job pause',async t=>{
 const root=directory(t),db=new Db(path.join(root,'index.json'),path.join(root,'data'));t.after(()=>db.store.close());
 for(const explicitlyPaused of [false,true]){
  db.store.setSetting('enhancementEnabled',true);const queue=new EnhancementQueue({dataDir:path.join(root,'data')},db);let rejectWork;
  const job={id:crypto.randomUUID(),state:'queued'};db.store.saveJob(job);
  queue.process=async active=>{active.state='running';queue.save(active);await new Promise((resolve,reject)=>{rejectWork=reject;});};
  await queue.tick();db.store.setSetting('enhancementEnabled',false);if(explicitlyPaused)queue.pause(job.id);rejectWork(Error('Interrupted'));
  for(let i=0;i<100&&queue.active;i++)await delay(5);assert.equal(queue.get(job.id).state,explicitlyPaused?'paused':'queued');
  db.store.saveJob({...queue.get(job.id),state:'completed'});await queue.stop();
 }
});
