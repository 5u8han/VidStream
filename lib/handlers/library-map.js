'use strict';
const {isAdmin}=require('../auth');
const {sendJson}=require('./api');
const creatorOf=i=>i.creator||(i.album?i.album.split('/')[0]:'(Unsorted)');
function libraryMapHandler(cfg,db){
 let snapshot=null;
 function catalog(){if(snapshot&&snapshot.version===db.revision)return snapshot;const groups=new Map(),files=[];
  for(const item of db.items.values()){
   if(!['photo','video'].includes(item.type))continue;
   const creator=creatorOf(item),bytes=Math.max(0,Number(item.size)||0);let group=groups.get(creator);if(!group){group={name:creator,count:0,bytes:0,photos:0,videos:0,files:[]};groups.set(creator,group);}group.count++;group.bytes+=bytes;group[item.type==='photo'?'photos':'videos']++;
   const file={id:item.id,name:item.filename,creator,type:item.type,bytes,width:item.width,height:item.height};group.files.push(file);files.push(file);
  }
  snapshot={version:db.revision,groups,files};return snapshot;
 }
 return (req,res)=>{
  if(!isAdmin(req,cfg))return sendJson(res,403,{error:'Admin sign-in required'});
  const q=new URL(req.url,'http://x').searchParams,c=catalog();res.setHeader('Cache-Control','no-store');
  if(q.has('version')&&Number(q.get('version'))!==c.version)return sendJson(res,409,{error:'Library changed; refresh the map'});
  if(q.get('detail')==='files'){
   const creator=q.get('creator'),files=creator===null?c.files:(c.groups.get(creator)?.files||[]),raw=Number(q.get('offset')),offset=Number.isSafeInteger(raw)&&raw>=0?raw:0,limit=2000;
   return sendJson(res,200,{version:c.version,files:files.slice(offset,offset+limit),total:files.length,nextOffset:offset+limit<files.length?offset+limit:null});
  }
  sendJson(res,200,{version:c.version,totalFiles:c.files.length,totalBytes:c.files.reduce((s,f)=>s+f.bytes,0),creators:[...c.groups.values()].map(({files,...g})=>g)});
 };
}
module.exports={libraryMapHandler};
