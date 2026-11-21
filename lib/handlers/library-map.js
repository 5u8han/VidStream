'use strict';
const {isAdmin}=require('../auth');
const {sendJson}=require('./api');
const creatorOf=i=>i.creator||(i.album?i.album.split('/')[0]:'(Unsorted)');
const FOLDERS_PER_PAGE = 240;

function folder(path, name) {
 return { path, name, count: 0, bytes: 0, directFiles: 0, directBytes: 0, children: new Map() };
}

function folderSummary({ path, name, count, bytes }) {
 return { path, name, count, bytes };
}

async function buildFolderTree(db) {
 const version = db.revision;
 const root = folder('', 'Whole library');
 let visited = 0;
 for (const item of db.visibleItems()) {
  if (++visited % 4096 === 0) await new Promise(setImmediate);
  if (item.type !== 'photo' && item.type !== 'video') continue;
  const parts = item.relPath.split('/');
  const bytes = Math.max(0, Number(item.size) || 0);
  let current = root;
  current.count++;
  current.bytes += bytes;
  for (const name of parts.slice(0, -1)) {
   let child = current.children.get(name);
   if (!child) {
    child = folder(current.path ? current.path + '/' + name : name, name);
    current.children.set(name, child);
   }
   child.count++;
   child.bytes += bytes;
   current = child;
  }
  current.directFiles++;
  current.directBytes += bytes;
 }
 return { version, root };
}

function folderBranchHandler(db) {
 let snapshot;
 let pending;
 return async (res, query) => {
  if (snapshot?.version !== db.revision) {
   pending ??= buildFolderTree(db).then(tree => { snapshot = tree; }).finally(() => { pending = null; });
   await pending;
  }
  if (res.destroyed) return;
  const breadcrumbs = [];
  let current = snapshot.root;
  const path = query.get('path');
  for (const name of !path ? [] : path.split('/')) {
   current = current.children.get(name);
   if (!current) return sendJson(res, 404, { error: 'This folder is no longer in the catalog. Return to All folders.' });
   breadcrumbs.push({ path: current.path, name: current.name });
  }
  const metric = query.get('metric') === 'files' ? 'count' : 'bytes';
  const requested = Number(query.get('offset'));
  const children = [...current.children.values()].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
  const last = Math.floor(Math.max(0, children.length - 1) / FOLDERS_PER_PAGE) * FOLDERS_PER_PAGE;
  const offset = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(last, requested) : 0;
  const end = offset + FOLDERS_PER_PAGE;
  return sendJson(res, 200, {
   ...folderSummary(current), breadcrumbs, directFiles: current.directFiles, directBytes: current.directBytes,
   children: children.slice(offset, end).map(folderSummary),
   folderCount: children.length, offset,
   previousOffset: offset ? Math.max(0, offset - FOLDERS_PER_PAGE) : null,
   nextOffset: end < children.length ? end : null,
  });
 };
}

function libraryMapHandler(cfg,db){
 let snapshot=null;
 const folderBranch = folderBranchHandler(db);
 function catalog(){if(snapshot&&snapshot.version===db.revision)return snapshot;const groups=new Map(),files=[];
  for(const item of db.visibleItems()){
   if(!['photo','video'].includes(item.type))continue;
   const creator=creatorOf(item),bytes=Math.max(0,Number(item.size)||0);let group=groups.get(creator);if(!group){group={name:creator,count:0,bytes:0,photos:0,videos:0,files:[]};groups.set(creator,group);}group.count++;group.bytes+=bytes;group[item.type==='photo'?'photos':'videos']++;
   const file={id:item.id,name:item.filename,creator,type:item.type,bytes,width:item.width,height:item.height};group.files.push(file);files.push(file);
  }
  snapshot={version:db.revision,groups,files};return snapshot;
 }
 return (req,res)=>{
  if(!isAdmin(req,cfg))return sendJson(res,403,{error:'Admin sign-in required'});
  const q=new URL(req.url,'http://x').searchParams;res.setHeader('Cache-Control','no-store');
  if(q.get('group')==='folders')return folderBranch(res,q);
  const c=catalog();
  if(q.has('version')&&Number(q.get('version'))!==c.version)return sendJson(res,409,{error:'Library changed; refresh the map'});
  if(q.get('detail')==='files'){
   const creator=q.get('creator'),files=creator===null?c.files:(c.groups.get(creator)?.files||[]),raw=Number(q.get('offset')),offset=Number.isSafeInteger(raw)&&raw>=0?raw:0,limit=2000;
   return sendJson(res,200,{version:c.version,files:files.slice(offset,offset+limit),total:files.length,nextOffset:offset+limit<files.length?offset+limit:null});
  }
  sendJson(res,200,{version:c.version,totalFiles:c.files.length,totalBytes:c.files.reduce((s,f)=>s+f.bytes,0),creators:[...c.groups.values()].map(({files,...g})=>g)});
 };
}
module.exports={libraryMapHandler};
