'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../public/preview-controller');
const {summarize,createMeasurements,trackPlayer,snapshot}=require('../public/diagnostics');
function fixture(limit=2){
 let next=0,raf=null;const timers=new Map(),released=[],videos=[];
 const controller=create({limit:()=>limit,enabled:()=>true,blocked:()=>false,releaseMs:2000,
  raf:fn=>{raf=fn;return ++next;},caf:()=>{raf=null;},later:fn=>{const id=++next;timers.set(id,fn);return id;},cancel:id=>timers.delete(id),
  attach:tile=>{if(tile._video)return tile._video;const v={currentTime:0,duration:20,readyState:1,pause(){},play(){return Promise.resolve();},removeAttribute(key){assert.equal(key,'src');},load(){},remove(){released.push(tile.id);},addEventListener(){}};videos.push(v);return tile._video=v;}});
 function tile(id,hover=false){return {id,isConnected:true,_item:{type:'video'},matches:()=>hover};}
 return {controller,tile,timers,released,videos,tick(){const work=Array.from(timers.values());timers.clear();work.forEach(fn=>fn());},raf(){if(raf){const f=raf;raf=null;f();}}};
}
test('preview sources survive the grace period, resume at their position, and are released offscreen',()=>{
 const f=fixture(),tile=f.tile('one');f.controller.setVisible(tile,true);tile._video.currentTime=7;
 f.controller.setVisible(tile,false);assert.equal(f.controller.running.size,0);assert.ok(tile._video);
 f.controller.setVisible(tile,true);f.tick();assert.ok(tile._video);assert.equal(f.released.length,0);
 f.controller.setVisible(tile,false);f.tick();assert.equal(tile._video,null);assert.deepEqual(f.released,['one']);
 f.controller.setVisible(tile,true);assert.equal(tile._video.currentTime,7);assert.equal(f.controller.running.size,1);
});
test('a hovered preview receives an existing slot without raising the configured cap',()=>{
 const f=fixture(2),a=f.tile('a'),b=f.tile('b'),c=f.tile('c',true);
 [a,b,c].forEach(t=>f.controller.setVisible(t,true));assert.equal(f.controller.running.size,2);assert.ok(f.controller.running.has(c));assert.ok(!f.controller.running.has(a));
});
test('filter reset releases all sources and clears pending refill/release work',()=>{
 const f=fixture(),a=f.tile('a'),b=f.tile('b');f.controller.setVisible(a,true);f.controller.setVisible(b,true);f.controller.setVisible(a,false);
 f.controller.clear();f.tick();f.raf();assert.deepEqual(f.released.sort(),['a','b']);assert.deepEqual(f.controller.stats(),{running:0,visible:0,retained:0,pendingRelease:0});assert.equal(a._video,null);assert.equal(b._video,null);
});
test('unmounting a tile immediately releases its preview and removes visible/refill references',()=>{
 const f=fixture(),tile=f.tile('unmount');f.controller.setVisible(tile,true);tile._video.currentTime=6;
 f.controller.release(tile);f.tick();f.raf();
 assert.equal(tile._video,null);assert.equal(tile._resumeAt,6);
 assert.deepEqual(f.controller.stats(),{running:0,visible:0,retained:0,pendingRelease:0});
 assert.deepEqual(f.released,['unmount']);
});
test('playback diagnostics report scheduling intervals without pretending to measure display refresh',()=>{
 const data=summarize([16,17,16,40,50],139);assert.equal(data.pageCallbackFps,5000/139);assert.equal(data.framesOver25Ms,2);assert.equal(data.p95FrameIntervalMs,50);
 assert.deepEqual(summarize([],0),{pageCallbackFps:null,p95FrameIntervalMs:null,framesOver25Ms:0});
});
test('passive diagnostics measure first useful media once and retain a bounded set of real catalog requests',()=>{
 let now=120; const metrics=createMeasurements(()=>now);
 assert.deepEqual(metrics.snapshot(),{firstVisibleLoadedThumbnailMs:null,firstPlayerFrame:null,recentCatalogResponses:[]});
 metrics.thumbnail();now=300;metrics.thumbnail();
 metrics.frame(42,'presented-frame callback');metrics.frame(2,'playing-event fallback');
 assert.equal(metrics.snapshot().firstVisibleLoadedThumbnailMs,120);
 assert.deepEqual(metrics.snapshot().firstPlayerFrame,{elapsedMs:42,method:'presented-frame callback'});
 for(let i=0;i<12;i++){now=400+i;metrics.catalog(now-20,200);}
 assert.equal(metrics.snapshot().recentCatalogResponses.length,10);
 assert.deepEqual(metrics.snapshot().recentCatalogResponses[0],{durationMs:20,finishedAtMs:402,status:200});
 const copy=metrics.snapshot();copy.recentCatalogResponses[0].durationMs=-1;copy.firstPlayerFrame.elapsedMs=-1;
 assert.equal(metrics.snapshot().recentCatalogResponses[0].durationMs,20);
 assert.equal(metrics.snapshot().firstPlayerFrame.elapsedMs,42);
 metrics.catalog(now+1,200);assert.equal(metrics.snapshot().recentCatalogResponses.length,10);
});
test('closing a player cancels its pending first-frame measurement',()=>{
 let callback,cancelled=0;
 const video={requestVideoFrameCallback(fn){callback=fn;return 71;},cancelVideoFrameCallback(id){assert.equal(id,71);cancelled++;},removeEventListener(){}};
 const stop=trackPlayer(video);stop();stop();callback();
 assert.equal(cancelled,1);assert.equal(snapshot().firstPlayerFrame,null);
});
