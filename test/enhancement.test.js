'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {Db}=require('../lib/db');
const {EnhancementQueue,optionsFor}=require('../lib/enhancement-queue');
const {run}=require('../lib/exec');
const {validateEvent,settingsHandlers}=require('../lib/handlers/settings');
const hasTools=spawnSync('ffmpeg',['-version']).status===0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<1000;i++){if(fn())return;await delay(10);}throw Error('Timed out');}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vidstream-enhance-')),cfg={mediaDir:path.join(root,'media'),dataDir:path.join(root,'data')};fs.mkdirSync(cfg.mediaDir);
 const db=new Db(path.join(root,'cache','index.json'),cfg.dataDir),queue=new EnhancementQueue(cfg,db);
 t.after(async()=>{await queue.stop();await until(()=>!queue.active);clearTimeout(db._saveTimer);db.store.close();fs.rmSync(root,{recursive:true,force:true});});return {root,cfg,db,queue};
}
function clip(cfg,duration=4.3){
 execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=64x48:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t',String(duration),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(cfg.mediaDir,'clip.mp4'),'-loglevel','error']);
 return {id:'clip',relPath:'clip.mp4',filename:'clip.mp4',type:'video',width:64,height:48,duration,tech:{frameRate:24},fingerprint:'original'};
}
test('activity is deduplicated, retains media identity and survives reopening / reindexing',t=>{
 const {db,cfg,root}=fixture(t),item={id:'first-id',relPath:'album/private.mp4'};db.upsert(item);db.store.update(item,{favorite:true});
 const event={id:crypto.randomUUID(),visitor:crypto.randomUUID(),action:'open',at:new Date().toISOString(),details:{}};
 db.store.track(item,event);db.store.track(item,event);db.store.track(item,{...event,id:crypto.randomUUID(),action:'watch',details:{seconds:12.5}});
 const again=new Db(path.join(root,'other-cache','index.json'),cfg.dataDir);t.after(()=>again.store.close());
 assert.equal(again.store.activityStats({...item,id:'new-id'}).opens,1);assert.equal(again.store.activityStats(item).watch_seconds,12.5);
 assert.equal(again.store.activityPage().events[0].path,item.relPath);assert.equal(again.store.history(item)[0].action,'preferences');
 assert.throws(()=>validateEvent({...event,action:'watch',details:{seconds:100}}));
});
test('guest cannot read settings, jobs, activity or enqueue enhancements',async t=>{
 const {db,queue}=fixture(t),cfg={adminPassword:'secret',sessionSecret:'secret'},h=settingsHandlers(cfg,db,queue,{});
 for(const method of ['get','jobs','activity','create','control','install']){
  const req={headers:{},url:'/api/settings'},res={writeHead(s){this.status=s;},end(){}};
  await h[method](req,res,{});assert.equal(res.status,403,method);
 }
});
test('options reject unsupported engines and oversized outputs',()=>{
 assert.throws(()=>optionsFor({smoothing:'remote-code'},{type:'video',duration:1}));
 assert.throws(()=>optionsFor({upscale:'realesrgan-x4plus'},{type:'video',duration:1,width:4000,height:3000}));
 assert.equal(optionsFor({smoothing:'none',upscale:'realesr-animevideov3'},{type:'video',duration:1,width:100,height:100,tech:{frameRate:24}}).fps,24);
});
test('real 60 fps job resumes verified segments after host migration without its original source', {skip:!hasTools},async t=>{
 const {root,cfg,db,queue}=fixture(t),item=clip(cfg);db.upsert(item);
 const original=fs.readFileSync(path.join(cfg.mediaDir,'clip.mp4'));
 let stopped=false;
 queue.runner=async(cmd,args,opts)=>{
  if(!stopped&&cmd==='ffmpeg'&&args.some(v=>String(v).includes('00000001.mp4'))){stopped=true;throw Error('Simulated power interruption');}
  return run(cmd,args,opts);
 };
 await queue.start();const created=await queue.create(item,{smoothing:'ffmpeg'});
 await until(()=>!queue.active&&queue.get(created.id).state==='paused');
 const saved=queue.get(created.id);assert.equal(saved.segments.length,1);assert.ok(saved.sourceHash);
 const first=path.join(queue.dir(saved.id),'segment-00000000.mp4'),firstBytes=fs.readFileSync(first);
 await queue.stop();
 // Copy data after stopping the old host. A fresh library index is intentionally absent.
 const moved=path.join(root,'new-host');fs.cpSync(cfg.dataDir,moved,{recursive:true});
 const db2=new Db(path.join(root,'new-cache','index.json'),moved),q2=new EnhancementQueue({dataDir:moved,mediaDir:path.join(root,'offline-nas')},db2);
 t.after(async()=>{await q2.stop();await until(()=>!q2.active);clearTimeout(db2._saveTimer);db2.store.close();});
 q2.resume(saved.id);await q2.start();await until(()=>!q2.active&&['completed','paused'].includes(q2.get(saved.id).state));
 const final=q2.get(saved.id);assert.equal(final.state,'completed',final.error);
 assert.deepEqual(fs.readFileSync(path.join(q2.dir(saved.id),'segment-00000000.mp4')),firstBytes);
 const result=JSON.parse(execFileSync('ffprobe',['-v','quiet','-show_streams','-show_format','-of','json',path.join(q2.dir(saved.id),'enhanced.mp4')],{encoding:'utf8'}));
 assert.equal(result.streams[0].avg_frame_rate,'60/1');assert.ok(result.streams.some(s=>s.codec_type==='audio'));
 assert.ok(Math.abs(Number(result.format.duration)-item.duration)<.08);
 assert.deepEqual(fs.readFileSync(path.join(cfg.mediaDir,'clip.mp4')),original);
});
test('very short videos can be smoothed and duplicate requests reuse the saved job',{skip:!hasTools},async t=>{
 const {cfg,db,queue}=fixture(t),item=clip(cfg,.05);db.upsert(item);await queue.start();const j=await queue.create(item,{});
 assert.equal((await queue.create(item,{})).id,j.id);
 await until(()=>!queue.active&&['completed','paused'].includes(queue.get(j.id).state));assert.equal(queue.get(j.id).state,'completed',queue.get(j.id).error);
});
test('worker lease prevents two active hosts and allows stopped host takeover',async t=>{
 const {cfg,db,queue}=fixture(t);assert.equal(queue.lease(),true);const other=new EnhancementQueue(cfg,db);assert.equal(other.lease(),false);await queue.stop();assert.equal(other.lease(),true);await other.stop();
});
test('AI frame checkpoints are verified and reused after an interrupted frame',async t=>{
 const {queue,db}=fixture(t);const job={id:crypto.randomUUID(),state:'running'};db.store.saveJob(job);queue.lease();const dir=queue.dir(job.id);fs.mkdirSync(dir,{recursive:true});const manifest={};let calls=0;
 const produce=async file=>{calls++;fs.writeFileSync(file,'verified output');};
 const output=await queue.cachedFrame(dir,'00000000.png',manifest,produce,job);
 await queue.cachedFrame(dir,'00000000.png',manifest,produce,job);assert.equal(calls,1);
 fs.writeFileSync(output,'corrupt');await queue.cachedFrame(dir,'00000000.png',manifest,produce,job);assert.equal(calls,2);
 await assert.rejects(queue.cachedFrame(dir,'00000001.png',manifest,async file=>{fs.writeFileSync(file,'partial');throw Error('power lost');},job));
 assert.ok(!manifest['00000001.png']);await queue.cachedFrame(dir,'00000001.png',manifest,produce,job);assert.equal(calls,3);
});
test('schema 1 migration preserves existing favorites and edit history',t=>{
 const {DatabaseSync}=require('node:sqlite');const {root}=fixture(t);const data=path.join(root,'legacy');fs.mkdirSync(data);
 const sql=new DatabaseSync(path.join(data,'library.sqlite'));
 sql.exec("CREATE TABLE media_state(path TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE events(id INTEGER PRIMARY KEY,path TEXT NOT NULL,at TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL);PRAGMA user_version=1;");
 sql.prepare('INSERT INTO media_state VALUES(?,?)').run('old.mp4',JSON.stringify({favorite:true,bookmarked:true}));
 sql.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(1,'old.mp4','2026-01-01','edited','{}');sql.close();
 const migrated=new Db(path.join(root,'legacy-cache','index.json'),data);migrated.upsert({id:'old',relPath:'old.mp4'});
 assert.equal(migrated.get('old').favorite,true);assert.equal(migrated.get('old').bookmarked,true);assert.equal(migrated.store.history(migrated.get('old'))[0].action,'edited');
 assert.equal(migrated.store.sql.prepare('PRAGMA user_version').get().user_version,2);clearTimeout(migrated._saveTimer);migrated.store.close();
});
