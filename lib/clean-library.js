'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {atomicJson,commitFile,digest,verified}=require('./durable-files');
class CleanLibrary {
 constructor(cfg,db,queue){this.cfg=cfg;this.db=db;this.queue=queue;this.root=path.resolve(cfg.cleanDir||path.join(cfg.dataDir,'clean-library'));this.active=false;this.stopping=false;
  const prior=this.status();if(prior.state==='running')this.save({...prior,state:'paused',error:'Export interrupted. Select Export / resume to continue.'});
 }
 status(){return this.db.store.setting('cleanExport',{state:'idle',directory:this.root,done:0,total:0});}
 save(state){this.db.store.setSetting('cleanExport',{...state,directory:this.root,updatedAt:new Date().toISOString()});}
 async start(includeOriginals=false){if(this.active)throw Error('An export is already running');this.active=true;this.save({state:'running',includeOriginals,done:0,total:0});this.process(includeOriginals).catch(e=>this.save({...this.status(),state:'paused',error:e.message})).finally(()=>{this.active=false;});return this.status();}
 async process(includeOriginals){
  const media=path.resolve(this.cfg.mediaDir);if(this.root===media||this.root.startsWith(media+path.sep)||media.startsWith(this.root+path.sep))throw Error('Export directory must be separate from the source library');
  await fs.mkdir(this.root,{recursive:true});let manifest={files:{}};
  try{manifest=JSON.parse(await fs.readFile(path.join(this.root,'manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const indexed=new Map([...this.db.items.values()].map(item=>[item.relPath,item]));
  const latest=new Map();for(const job of this.db.store.jobs().slice().reverse())if(job.state==='completed'&&indexed.get(job.relPath)?.fingerprint===job.sourceFingerprint)latest.set(job.relPath,job);
  const items=[...this.db.items.values()].filter(item=>includeOriginals||latest.has(item.relPath));this.save({...this.status(),total:items.length});
  for(const item of items){
   if(this.stopping)throw Error('Server stopped; export can be resumed');
   const job=latest.get(item.relPath);const usable=job&&job.sourceFingerprint===item.fingerprint;
   if(!usable&&!includeOriginals)continue;
   const relative=usable?path.join(path.dirname(item.relPath),path.parse(item.filename).name+'--'+job.id+'.mp4'):item.relPath;
   const dest=path.resolve(this.root,relative);if(!dest.startsWith(this.root+path.sep))throw Error('Invalid export path');
   const source=usable?path.join(this.queue.dir(job.id),'enhanced.mp4'):path.resolve(this.cfg.mediaDir,item.relPath);
   const sourceReal=await fs.realpath(source),sourceRoot=await fs.realpath(usable?this.queue.root:this.cfg.mediaDir);if(!sourceReal.startsWith(sourceRoot+path.sep))throw Error('Source is outside its library');
   await fs.mkdir(path.dirname(dest),{recursive:true});const destParent=await fs.realpath(path.dirname(dest)),exportRoot=await fs.realpath(this.root);if(destParent!==exportRoot&&!destParent.startsWith(exportRoot+path.sep))throw Error('Export directory contains an external symlink');
   const sourceStat=await fs.stat(sourceReal),hash=usable?job.outputHash:await digest(sourceReal),old=manifest.files[relative];
   if(usable&&!await verified(sourceReal,hash))throw Error('Saved enhancement failed checksum verification');
   let exists=false;try{await fs.lstat(dest);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(exists&&(!old||(!await verified(dest,old.hash)&&!await verified(dest,old.pendingHash))))throw Error('Refusing to overwrite an unrelated or externally changed export: '+relative);
   if(!old||old.hash!==hash||!exists){
    manifest.files[relative]={...old,pendingHash:hash};await atomicJson(path.join(this.root,'manifest.json'),manifest);
    const temporary=dest+'.vidstream-'+require('node:crypto').randomUUID()+'.partial';await fs.copyFile(sourceReal,temporary,require('node:fs').constants.COPYFILE_EXCL);
    const after=await fs.stat(sourceReal);if(sourceStat.size!==after.size||sourceStat.mtimeMs!==after.mtimeMs||!await verified(temporary,hash))throw Error('Source changed during export; retry after the library is stable');
    await commitFile(temporary,dest);
   }
   manifest.files[relative]={source:item.relPath,itemId:item.id,jobId:usable?job.id:null,hash,kind:usable?'enhanced':'original'};
   await atomicJson(path.join(this.root,'manifest.json'),manifest);
   // Keep only the current version visible, archiving our verified previous exports.
   for(const [previous,record] of Object.entries(manifest.files)){
    if(previous===relative||record.source!==item.relPath)continue;
    const oldPath=path.resolve(this.root,previous);if(!oldPath.startsWith(this.root+path.sep))throw Error('Invalid previous export path');
    const priorParent=await fs.realpath(path.dirname(oldPath));if(priorParent!==exportRoot&&!priorParent.startsWith(exportRoot+path.sep))throw Error('Previous export has an external symlink parent');
    let exists=false;try{await fs.lstat(oldPath);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(exists){if(!await verified(oldPath,record.hash))throw Error('Previous export was modified outside VidStream: '+previous);
     const archived=path.join('.vidstream-previous',require('node:crypto').randomUUID(),path.basename(previous));await fs.mkdir(path.dirname(path.join(this.root,archived)),{recursive:true});const archiveParent=await fs.realpath(path.dirname(path.join(this.root,archived)));if(!archiveParent.startsWith(exportRoot+path.sep))throw Error('Archive directory has an external symlink');await commitFile(oldPath,path.join(this.root,archived));
     (manifest.archives ||= []).push({...record,path:previous,archivedAs:archived});
    }
    delete manifest.files[previous];await atomicJson(path.join(this.root,'manifest.json'),manifest);
   }
   this.save({...this.status(),done:this.status().done+1,current:relative});
  }
  this.save({...this.status(),state:'completed',current:null,error:null});
 }
 stop(){this.stopping=true;}
}
module.exports={CleanLibrary};
