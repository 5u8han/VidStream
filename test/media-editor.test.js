'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync,spawnSync} = require('node:child_process');
const {Db} = require('../lib/db');
const {MediaEditor} = require('../lib/media-editor');
const hasTools = ['ffmpeg','convert'].every(cmd => spawnSync(cmd,['-version']).status === 0);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('real video edits preserve an exact original and preferences; invalid edits leave source intact', {skip:!hasTools}, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-editor-'));
 const cfg={mediaDir:path.join(dir,'media'),cacheDir:path.join(dir,'cache')}; fs.mkdirSync(cfg.mediaDir);
 const source=path.join(cfg.mediaDir,'clip.mp4');
 execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=120x200:rate=60','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source,'-loglevel','error']);
 const db=new Db(path.join(cfg.cacheDir,'index.json'));
 t.after(()=>{clearTimeout(db._saveTimer);db.store.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.upsert({id:'clip',relPath:'clip.mp4',filename:'clip.mp4',type:'video',ext:'.mp4',width:120,height:200,duration:2});
 const item=db.get('clip');db.store.update(item,{favorite:true});
 const scanner={scanning:false,failed:[],scan:async()=>({updated:1})}; const editor=new MediaEditor(cfg,db,scanner);
 const original=hash(source);
 await assert.rejects(editor.edit(item,{start:4,end:1})); assert.equal(hash(source),original);
 scanner.scanning=true;await assert.rejects(editor.edit(item,{}),/in progress/);scanner.scanning=false;
 await editor.edit(item,{x:10,y:20,width:100,height:160,maxWidth:80,start:.5,end:1.5});
 const saved=db.store.history(item).find(e=>e.action==='edited');
 assert.equal(hash(path.join(cfg.mediaDir,saved.data.backup)),original); assert.notEqual(hash(source),original);
 assert.equal(item.favorite,true);assert.equal(scanner.editing,false);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','quiet','-print_format','json','-show_streams','-show_format',source],{encoding:'utf8'}));
 assert.equal(probe.streams[0].width,80);assert.equal(probe.streams[0].height,128);assert.equal(probe.streams[0].avg_frame_rate,'60/1');
 assert.ok(Math.abs(Number(probe.format.duration)-1)<.05);
});

test('photo metadata and derivatives work with ImageMagick 6 and 7', {skip:!hasTools}, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-photo-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'photo.jpg');
 execFileSync('convert',['-size','120x200','gradient:navy-coral',source],{stdio:'pipe'});
 const {processPhoto}=require('../lib/media-photo');
 const result=await processPhoto(source,'.jpg',{
   thumb:(w,ext)=>path.join(dir,'thumb-'+w+ext),large:(w,ext)=>path.join(dir,'large-'+w+ext),
 },{thumbnailSizes:[60],largeSizes:[100],enableFaceDetection:false,enablePetDetection:false,enableOcr:false,enableDuplicateDetection:false,enableObjectDetection:false});
 assert.equal(result.width,120);assert.equal(result.height,200);assert.ok(fs.statSync(path.join(dir,'thumb-60.jpg')).size>0);
});
