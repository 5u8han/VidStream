'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {treemap,outlines}=require('../public/library-layout');
const {libraryMapHandler}=require('../lib/handlers/library-map');
test('treemap fills its bounds with proportional, non-overlapping areas',()=>{
 const input=Array.from({length:400},(_,i)=>({id:String(i),value:i+1}));
 const rects=treemap(input,5,8,1100,600),total=input.reduce((n,r)=>n+r.value,0);
 assert.equal(rects.length,400);
 for(let i=0;i<rects.length;i++){
  const a=rects[i];assert.ok(a.x>=5-1e-6&&a.y>=8-1e-6&&a.x+a.w<=1105+1e-6&&a.y+a.h<=608+1e-6);
  assert.ok(Math.abs(a.w*a.h-a.value/total*660000)<1e-5);
  for(const b of rects.slice(i+1))assert.ok(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)<1e-6||Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)<1e-6);
 }
 assert.deepEqual(treemap([{value:0},{value:NaN}],0,0,100,100),[]);
});
test('individual borders stay inset and retain edges between matching artists',()=>{
 const {paths}=outlines([{x:0,y:0,w:100,h:80,creator:'A'},{x:100,y:0,w:100,h:80,creator:'A'},{x:200,y:0,w:100,h:80,creator:'B'}]);
 assert.equal(paths.length,2);assert.equal(paths[0].d,'M1 1h98v78h-98ZM101 1h98v78h-98Z');
});
test('library map protects private data, pages all media and invalidates snapshots',()=>{
 const db={revision:0,items:new Map(Array.from({length:2001},(_,i)=>[String(i),{id:String(i),filename:i+'.jpg',type:'photo',album:'Artist/subfolder',size:10}]))};
 function invoke(handler,url){const res={setHeader(){},writeHead(code){this.status=code;},end(body){this.data=JSON.parse(body);}};handler({url,headers:{}},res);return res;}
 assert.equal(invoke(libraryMapHandler({adminPassword:'secret'},db),'/api/library-map').status,403);
 const handler=libraryMapHandler({},db);let res=invoke(handler,'/api/library-map');assert.equal(res.data.totalBytes,20010);assert.equal(res.data.creators[0].name,'Artist');
 res=invoke(handler,'/api/library-map?detail=files');assert.equal(res.data.files.length,2000);assert.equal(res.data.nextOffset,2000);
 res=invoke(handler,'/api/library-map?detail=files&offset=2000');assert.equal(res.data.files.length,1);assert.equal(res.data.nextOffset,null);
 db.items.delete('0');db.revision++;
 assert.equal(invoke(handler,'/api/library-map?version=0').status,409);assert.equal(invoke(handler,'/api/library-map').data.totalFiles,2000);
});
