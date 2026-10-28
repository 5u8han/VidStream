'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {run}=require('./exec');
const {atomicJson,commitFile,digest,verified}=require('./durable-files');
const {EnhancementModels,MODELS}=require('./enhancement-models');
const {hardwareSummary}=require('./ai-manager');
const FRAME=/^\d{8}\.png$/;
const number=n=>String(n).padStart(8,'0');

function optionsFor(body,item) {
 const smoothing=body.smoothing||'ffmpeg',upscale=body.upscale||'none';
 if(!['none','ffmpeg','rife-v4.6'].includes(smoothing))throw Error('Unsupported smoothing engine');
 if(!['none','realesrgan-x4plus','realesr-animevideov3'].includes(upscale))throw Error('Unsupported upscale model');
 if(smoothing==='none'&&upscale==='none')throw Error('Choose smoothing or upscaling');
 if(item.type!=='video'||!(item.duration>0))throw Error('Choose a video with a known duration');
 const sourceFps=Math.min(240,Math.max(1,Number(item.tech?.frameRate)||30));
 const fps=smoothing==='none'?sourceFps:60,scale=upscale==='none'?1:MODELS[upscale].scale;
 if(item.width*scale>8192||item.height*scale>8192)throw Error('Enhanced output exceeds the 8192-pixel limit; choose a smaller scale');
 return {smoothing,upscale,sourceFps,fps,scale,version:1};
}
class EnhancementQueue {
 constructor(cfg,db,{runner=run}={}) {
  Object.assign(this,{cfg,db,runner});this.root=path.join(cfg.dataDir,'enhancements');this.models=new EnhancementModels(cfg);
  this.owner=crypto.randomUUID();this.active=null;this.controller=null;this.stopping=false;this.timer=null;this.lastError=null;
  this.db.store.sql.exec('CREATE TABLE IF NOT EXISTS worker_lease (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)');
 }
 dir(id) {if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid job');return path.join(this.root,id);}
 get(id) {return this.db.store.jobs().find(j=>j.id===id);}
 save(job) {job.updatedAt=new Date().toISOString();this.db.store.saveJob(job);}
 async start() {
  await fs.mkdir(this.root,{recursive:true});
  this.timer=setInterval(()=>this.tick().catch(e=>{this.lastError=e.message;}),2000);this.timer.unref();
  await this.tick();
 }
 lease() {
  const sql=this.db.store.sql,now=Date.now();
  sql.prepare(`INSERT INTO worker_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
    WHERE worker_lease.owner=excluded.owner OR worker_lease.expires<?`).run(this.owner,now+15000,now);
  return sql.prepare('SELECT owner FROM worker_lease WHERE id=1').get()?.owner===this.owner;
 }
 async tick() {
  if(this.stopping||!this.lease())return;
  if(this.active)return;
  const job=this.db.store.jobs().reverse().find(j=>['queued','running'].includes(j.state));
  if(!job)return;
  this.active=job;this.controller=new AbortController();
  this.process(job).catch(error=>{
    if(this.lease()&&!this.stopping){job.state='paused';job.error=error.message.slice(0,500);this.save(job);}
  }).finally(()=>{this.active=null;this.controller=null;});
 }
 async create(item,body) {
  const options=optionsFor(body,item);
  const existing=this.db.store.jobs().find(j=>j.itemId===item.id&&j.sourceFingerprint===item.fingerprint&&JSON.stringify(j.options)===JSON.stringify(options)&&j.state!=='cancelled');
  if(existing)return existing;
  const source=await fs.realpath(path.join(this.cfg.mediaDir,item.relPath));const root=await fs.realpath(this.cfg.mediaDir);
  if(!source.startsWith(root+path.sep))throw Error('Source must be inside the library');
  const stat=await fs.stat(source);
  const job={id:crypto.randomUUID(),itemId:item.id,relPath:item.relPath,filename:item.filename,sourceFingerprint:item.fingerprint,
    sourceSize:stat.size,sourceMtime:stat.mtimeMs,sourceExt:path.extname(item.filename),duration:item.duration,width:item.width,height:item.height,
    options,state:'queued',phase:'Preparing',progress:0,segments:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:null};
  await fs.mkdir(this.dir(job.id),{recursive:true});this.save(job);void this.tick();return job;
 }
 check(job) {
  if(this.stopping||!this.lease()||this.controller?.signal.aborted||this.get(job.id)?.state==='paused')throw Error('Paused at the last verified checkpoint');
 }
 async disk(dir) { const stat=await fs.statfs(dir);if(stat.bavail*stat.bsize<128*1024*1024)throw Error('Less than 128 MiB free; free disk space and resume'); }
 async command(cmd,args) {return this.runner(cmd,args,{timeout:3600000,signal:this.controller?.signal,maxBuffer:1024*1024});}
 async snapshot(job) {
  const dir=this.dir(job.id),dest=path.join(dir,'source'+job.sourceExt),partial=dest+'.partial';
  if(job.sourceHash&&await verified(dest,job.sourceHash))return dest;
  const source=await fs.realpath(path.join(this.cfg.mediaDir,job.relPath));const root=await fs.realpath(this.cfg.mediaDir);
  if(!source.startsWith(root+path.sep))throw Error('Source must be inside the library');
  const stat=await fs.stat(source);if(stat.size!==job.sourceSize||Math.abs(stat.mtimeMs-job.sourceMtime)>1)throw Error('Source changed; restore the original source or create a new job');
  const input=await fs.open(source,'r'),output=await fs.open(partial,'a+');
  try {
   let offset=(await output.stat()).size;if(offset>stat.size)throw Error('Partial source snapshot is invalid');
   // Verify a migrated partial copy byte-for-byte before appending from a new host.
   const a=Buffer.alloc(8*1024*1024),b=Buffer.alloc(a.length);
   for(let pos=0;pos<offset;pos+=a.length){this.check(job);const len=Math.min(a.length,offset-pos);await input.read(a,0,len,pos);await output.read(b,0,len,pos);if(!a.subarray(0,len).equals(b.subarray(0,len)))throw Error('Source differs from its saved partial copy');}
   while(offset<stat.size){this.check(job);await this.disk(dir);const {bytesRead}=await input.read(a,0,Math.min(a.length,stat.size-offset),offset);if(!bytesRead)throw Error('Source became unavailable');await output.write(a,0,bytesRead);await output.sync();offset+=bytesRead;job.phase='Saving source';job.sourceCopied=offset;this.save(job);}
   const after=await input.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Source changed while snapshotting; create a fresh job');
  } finally {await input.close();await output.close();}
  this.check(job);await commitFile(partial,dest);job.sourceHash=await digest(dest);this.save(job);return dest;
 }
 async cachedFrame(dir,name,manifest,create,job) {
  const file=path.join(dir,name);if(await verified(file,manifest[name]))return file;
  this.check(job);await this.disk(dir);
  const temp=path.join(dir,'partial-'+this.owner+'-'+name);await create(temp);this.check(job);
  if(!(await fs.stat(temp)).size)throw Error('Empty generated frame');await commitFile(temp,file);
  manifest[name]=await digest(file);await atomicJson(path.join(dir,'frames.json'),manifest);return file;
 }
 async readManifest(dir) {try{return JSON.parse(await fs.readFile(path.join(dir,'frames.json'),'utf8'));}catch{return {};}}
 async aiFrames(job,source,start,frames,dir,device) {
  const opt=job.options;
  const nativeDir=path.join(dir,'decoded'),smoothDir=path.join(dir,'smooth'),outDir=path.join(dir,'upscaled');
  for(const d of [nativeDir,smoothDir,outDir])await fs.mkdir(d,{recursive:true});
  const first=Math.floor(start*opt.sourceFps),count=Math.ceil(frames/opt.fps*opt.sourceFps)+2;
  const decodeMarker=path.join(nativeDir,'complete.json');
  let ready=false;try{const marker=JSON.parse(await fs.readFile(decodeMarker,'utf8'));ready=Object.keys(marker).length>0&&(await Promise.all(Object.entries(marker).map(([name,hash])=>verified(path.join(nativeDir,name),hash)))).every(Boolean);}catch{}
  if(!ready){
   await this.command('ffmpeg',['-y','-ss',String(first/opt.sourceFps),'-i',source,'-vf','fps='+opt.sourceFps,'-frames:v',String(count),'-start_number','0',path.join(nativeDir,'%08d.png'),'-loglevel','error']);
   const marker={};for(const name of (await fs.readdir(nativeDir)).filter(n=>FRAME.test(n)))marker[name]=await digest(path.join(nativeDir,name));
   if(!Object.keys(marker).length)throw Error('Could not decode video frames');await atomicJson(decodeMarker,marker);
  }
  const decoded=(await fs.readdir(nativeDir)).filter(n=>FRAME.test(n)).sort();
  const smooth=await this.readManifest(smoothDir),upscaled=await this.readManifest(outDir);
  for(let frame=0;frame<frames;frame++){
   this.check(job);const position=(start+frame/opt.fps)*opt.sourceFps-first;
   const i=Math.min(decoded.length-1,Math.max(0,Math.floor(position+1e-7))),fraction=Math.max(0,position-Math.floor(position+1e-7));
   const left=path.join(nativeDir,decoded[i]),right=path.join(nativeDir,decoded[Math.min(i+1,decoded.length-1)]),name=number(frame)+'.png';
   let current=left;
   if(opt.smoothing==='rife-v4.6'){
    current=await this.cachedFrame(smoothDir,name,smooth,async temp=>{
     if(fraction<.0001||left===right)await fs.copyFile(left,temp);
     else await this.command('rife-ncnn-vulkan',['-0',left,'-1',right,'-o',temp,'-s',String(fraction),'-m',this.models.dir('rife-v4.6'),'-g',device==='cpu'?'-1':'0','-j','1:1:1']);
    },job);
   } else if(opt.smoothing==='ffmpeg') {
    // CPU optical-flow smoothing is generated once per chunk before AI upscaling.
    current=path.join(smoothDir,name);
   }
   if(opt.upscale!=='none') await this.cachedFrame(outDir,name,upscaled,temp=>this.command('realesrgan-ncnn-vulkan',
     ['-i',current,'-o',temp,'-n',opt.upscale,'-s',String(opt.scale),'-m',this.models.dir(opt.upscale),'-t','128','-g','0','-j','1:1:1']),job);
   else if(opt.smoothing==='none')await this.cachedFrame(smoothDir,name,smooth,temp=>fs.copyFile(current,temp),job);
   job.phase='Enhancing frames';job.currentFrame=Math.round(start*opt.fps)+frame+1;
   job.progress=Math.min(.99,job.currentFrame/Math.ceil(job.duration*opt.fps));this.save(job);
  }
  return opt.upscale!=='none'?outDir:smoothDir;
 }
 async process(job) {
  this.check(job);job.state='running';job.error=null;this.save(job);
  const opt=job.options,device=this.db.store.setting('enhancementDevice','auto');
  const hardware=await hardwareSummary();
  const effectiveDevice=device==='auto'?(hardware.gpu.length?'gpu':'cpu'):device;
  job.effectiveDevice=opt.upscale!=='none'?'gpu':opt.smoothing==='ffmpeg'?'cpu':effectiveDevice;this.save(job);
  if(opt.smoothing==='rife-v4.6'&&(!this.models.installed('rife-v4.6')||!this.models.runtime('rife')))throw Error('Install the RIFE model and optional enhancement runtime, then resume');
  if(opt.upscale!=='none'&&(!this.models.installed(opt.upscale)||!this.models.runtime('esrgan')))throw Error('Install the upscale model and optional enhancement runtime, then resume');
  if(opt.upscale!=='none'&&device==='cpu')throw Error('Real-ESRGAN needs Vulkan; choose Auto/GPU on a suitable host and resume');
  const source=await this.snapshot(job),dir=this.dir(job.id),fps=opt.fps,total=Math.ceil(job.duration*fps),chunkFrames=Math.round(fps*2);
  const totalSegments=Math.ceil(total/chunkFrames);
  for(let segment=0;segment<totalSegments;segment++){
   this.check(job);const dest=path.join(dir,`segment-${number(segment)}.mp4`);
   if(job.segments[segment]&&await verified(dest,job.segments[segment]))continue;
   const frames=Math.min(chunkFrames,total-segment*chunkFrames),start=segment*chunkFrames/fps;
   const chunk=path.join(dir,'chunk-'+number(segment));await fs.mkdir(chunk,{recursive:true});
   const temp=path.join(dir,`partial-${this.owner}-${number(segment)}.mp4`);
   const filters=opt.smoothing==='ffmpeg'?'tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1':'fps='+fps;
   const context=Math.min(.25,start);
   const smoothingFilters=filters+`,trim=start=${context},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`;
   if(opt.smoothing==='ffmpeg'&&opt.upscale==='none') {
    await this.command('ffmpeg',['-y','-ss',String(start-context),'-i',source,'-an','-vf',smoothingFilters,'-frames:v',String(frames),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',temp,'-loglevel','error']);
   } else {
    if(opt.smoothing==='ffmpeg'){
     const smoothDir=path.join(chunk,'smooth');await fs.mkdir(smoothDir,{recursive:true});
     const marker=path.join(smoothDir,'cpu-complete.json');let ready=false;
     try{const hashes=JSON.parse(await fs.readFile(marker,'utf8'));ready=Object.keys(hashes).length===frames&&(await Promise.all(Object.entries(hashes).map(([n,h])=>verified(path.join(smoothDir,n),h)))).every(Boolean);}catch{}
     if(!ready){await this.command('ffmpeg',['-y','-ss',String(start-context),'-i',source,'-vf',smoothingFilters,'-frames:v',String(frames),'-start_number','0',path.join(smoothDir,'%08d.png'),'-loglevel','error']);
      const hashes={};for(let i=0;i<frames;i++)hashes[number(i)+'.png']=await digest(path.join(smoothDir,number(i)+'.png'));await atomicJson(marker,hashes);}
    }
    const framesDir=await this.aiFrames(job,source,start,frames,chunk,effectiveDevice);
    await this.command('ffmpeg',['-y','-framerate',String(fps),'-start_number','0','-i',path.join(framesDir,'%08d.png'),'-frames:v',String(frames),'-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',temp,'-loglevel','error']);
   }
   this.check(job);
   const probe=JSON.parse((await this.command('ffprobe',['-v','quiet','-show_streams','-print_format','json',temp])).stdout);
   if(Number(probe.streams?.[0]?.nb_frames)!==frames)throw Error('Generated segment has an unexpected frame count');
   await commitFile(temp,dest);job.segments[segment]=await digest(dest);job.progress=(segment+1)/totalSegments*.99;job.phase='Segment saved';this.save(job);
  }
  this.check(job);job.phase='Assembling saved video';this.save(job);
  const concat=path.join(dir,'segments.txt');await fs.writeFile(concat,job.segments.map((_,i)=>`file 'segment-${number(i)}.mp4'`).join('\n'));
  const output=path.join(dir,'enhanced.mp4'),temp=path.join(dir,`final-${this.owner}.mp4`);
  await this.command('ffmpeg',['-y','-f','concat','-safe','1','-i',concat,'-i',source,'-map','0:v:0','-map','1:a:0?','-c:v','copy','-c:a','aac','-t',String(job.duration),'-movflags','+faststart',temp,'-loglevel','error']);
  this.check(job);await commitFile(temp,output);job.outputHash=await digest(output);job.state='completed';job.progress=1;job.phase='Ready';job.completedAt=new Date().toISOString();this.save(job);
 }
 pause(id) {const job=this.get(id);if(!job)throw Error('Job not found');if(job.state==='completed')return job;job.state='paused';job.error=null;this.save(job);if(this.active?.id===id)this.controller?.abort();return job;}
 resume(id) {const job=this.get(id);if(!job)throw Error('Job not found');if(job.state==='completed')return job;if(this.active?.id===id)throw Error('Pause is finishing; retry in a moment');job.state='queued';job.error=null;this.save(job);void this.tick();return job;}
 async stop() {this.stopping=true;clearInterval(this.timer);this.controller?.abort();if(this.active){const j=this.get(this.active.id);if(j?.state==='running'){j.state='queued';this.save(j);}}this.db.store.sql.prepare('DELETE FROM worker_lease WHERE owner=?').run(this.owner);}
}
module.exports={EnhancementQueue,optionsFor};
