'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Db } = require('../lib/db');
const { publicItem } = require('../lib/serialize');
const { validateEdit } = require('../lib/media-editor');
const { libraryHandlers } = require('../lib/handlers/library');

function record(id, extra={}) {return { id,relPath:'Album/'+id+'.mp4',filename:id+'.mp4',type:'video',ext:'.mp4',width:1080,height:1920,duration:10,mtime:'2026-01-01',addedAt:'2025-01-01',...extra };}
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-library-'));
 const db=new Db(path.join(dir,'cache','index.json'),path.join(dir,'data'));
 t.after(()=>{clearTimeout(db._saveTimer);db.store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {db,dir};
}
test('preferences survive rescan, removal, restart, index rebuild, and slug change',t=>{
 const {db,dir}=fixture(t); db.upsert(record('a'));
 db.store.update(db.get('a'),{favorite:true,pinned:true,bookmarked:true,guest:true});
 db.upsert(record('a',{guest:false})); assert.equal(db.get('a').favorite,true); assert.equal(db.get('a').guest,true);
 db.remove('a'); db.upsert(record('new-id',{relPath:'Album/a.mp4',addedAt:'2026-09-01'}));
 assert.equal(db.get('new-id').addedAt,'2025-01-01');
 const again=new Db(path.join(dir,'fresh-cache','index.json'),path.join(dir,'data'));
 again.upsert(record('reindexed',{relPath:'Album/a.mp4'}));
 assert.equal(again.get('reindexed').bookmarked,true); assert.equal(again.get('reindexed').pinned,true);
 assert.equal(again.get('reindexed').history.length,1);
 clearTimeout(again._saveTimer);again.store.close();
});
test('best items sort first across creators with stable pagination and matching neighbors',t=>{
 const {db}=fixture(t); for(const id of ['a','b','c'])db.upsert(record(id));
 db.store.update(db.get('b'),{favorite:true}); db.store.update(db.get('c'),{pinned:true});
 const first=db.query({sort:'name-asc',limit:1}); assert.equal(first.items[0].id,'c');
 assert.equal(db.query({sort:'name-asc',cursor:first.nextCursor,limit:1}).items[0].id,'b');
 assert.equal(db.neighbors('b',{sort:'name-asc'}).prev.id,'c');
 assert.equal(db.query({has:'favorite'}).total,1);
});
test('media versions invalidate browser caches and sensitive details stay admin-only',()=>{
 const cfg={mediaDir:'/media/private',thumbnailSizes:[320],posterSizes:[480],largeSizes:[1280]};
 const item=record('a',{metadata:{GPSLatitude:42},history:[{action:'edited'}],fingerprint:'old'});
 const old=publicItem(item,cfg,true),guest=publicItem(item,cfg);
 assert.equal(guest.info.path,null); assert.deepEqual(guest.info.metadata,{}); assert.deepEqual(guest.info.history,[]);
 assert.equal(old.info.path,'/media/private/Album/a.mp4');
 item.fingerprint='new'; const current=publicItem(item,cfg,true);
 assert.notEqual(old.urls.preview,current.urls.preview); assert.match(current.urls.thumbSrcset,/&v=\w+ 480w/);
});
test('invalid crops, trim ranges, unsupported formats, and upscaling are rejected',()=>{
 const item=record('a');
 for(const spec of [{x:-1},{width:2000},{end:11},{start:8,end:2},{maxWidth:2000},{x:'NaN'}])assert.throws(()=>validateEdit(item,spec));
 assert.throws(()=>validateEdit({...item,isAnimated:true},{}));
 assert.deepEqual(validateEdit(item,{start:2,end:7}).start,2);
});
test('guests cannot change preferences or edit files',async()=>{
 const handlers=libraryHandlers({adminPassword:'secret'},{get(){throw Error('must not access');}},{});
 for(const handler of Object.values(handlers)) {
  const res={writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}};
  await handler({headers:{}},res,{id:'a'});assert.equal(res.code,403);
 }
});
