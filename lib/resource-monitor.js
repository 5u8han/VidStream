'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {run}=require('./exec');
const numeric=v=>Number.isFinite(Number(v))?Number(v):null;
function pairs(raw){return Object.fromEntries(String(raw||'').trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(x=>x.length>=2).map(([k,v])=>[k.replace(/:$/,''),numeric(v)]));}
function ioCounters(raw){if(!raw)return null;let read=0,write=0;for(const line of raw.trim().split('\n'))for(const part of line.split(/\s+/)){const [key,value]=part.split('=');if(key==='rbytes')read+=Number(value)||0;if(key==='wbytes')write+=Number(value)||0;}return {read,write};}
function networkCounters(raw){if(!raw)return null;let received=0,sent=0;for(const line of raw.split('\n')){const [name,rest]=line.split(':');if(!rest||name.trim()==='lo')continue;const n=rest.trim().split(/\s+/).map(Number);received+=n[0]||0;sent+=n[8]||0;}return {received,sent};}
async function read(file){try{return await fs.readFile(file,'utf8');}catch{return null;}}
const delta=(a,b)=>a==null||b==null?null:Math.max(0,a-b);
class ResourceMonitor {
 constructor(cfg,store){this.cfg=cfg;this.store=store;this.previous=null;this.cached=null;this.pending=null;}
 async sample(){if(this.cached&&Date.now()-this.cached.at<3000)return this.cached;if(this.pending)return this.pending;this.pending=this.collect().finally(()=>{this.pending=null;});return this.pending;}
 async collect(){
  const now=Date.now(),cpu=os.cpus().reduce((a,c)=>{a.idle+=c.times.idle;a.total+=Object.values(c.times).reduce((x,y)=>x+y,0);return a;},{idle:0,total:0});
  const [cpuRaw,limitRaw,memoryRaw,memoryMax,ioRaw,selfIo,netRaw,memInfo]=await Promise.all(['/sys/fs/cgroup/cpu.stat','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max','/sys/fs/cgroup/io.stat','/proc/self/io','/proc/net/dev','/proc/meminfo'].map(read));
  const cgroup=cpuRaw!==null,usage=process.cpuUsage(),cpuMicros=cgroup?pairs(cpuRaw).usage_usec:usage.user+usage.system;
  const limits=(limitRaw||'').trim().split(' '),quota=limits[0]!=='max'&&Number(limits[0])>0?Number(limits[0])/Number(limits[1]):os.availableParallelism();
  const mem=pairs(memInfo),memoryLimit=Number(memoryMax)>0?Number(memoryMax):os.totalmem();
  const processIo=pairs(selfIo);let io=ioCounters(ioRaw)||(selfIo?{read:processIo.read_bytes,write:processIo.write_bytes}:null),net=networkCounters(netRaw);
  let native=null;if(process.platform==='darwin'){try{native=JSON.parse((await run('python3',[path.join(__dirname,'native-metrics.py')],{timeout:7000,maxBuffer:1048576})).stdout);io=native.io;net=native.network;}catch{}}
  const before=this.previous,seconds=before?(now-before.at)/1000:null;
  let disk=null;try{const d=await fs.statfs(this.cfg.dataDir);disk={totalBytes:d.blocks*d.bsize,availableBytes:d.bavail*d.bsize};}catch{}
  let gpu=[];try{const r=await run('nvidia-smi',['--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,temperature.gpu','--format=csv,noheader,nounits'],{timeout:2000,maxBuffer:8192});gpu=r.stdout.trim().split('\n').filter(Boolean).map(line=>{const v=line.split(',').map(x=>x.trim());return {name:v[0],utilizationPercent:numeric(v[1]),memoryControllerPercent:numeric(v[2]),totalBytes:numeric(v[3])===null?null:Number(v[3])*1048576,usedBytes:numeric(v[4])===null?null:Number(v[4])*1048576,powerWatts:numeric(v[5]),temperatureC:numeric(v[6])};});}catch{}
  if(native?.gpu?.length)gpu=native.gpu;
  const readDelta=delta(io?.read,before?.io?.read),writeDelta=delta(io?.write,before?.io?.write),rxDelta=delta(net?.received,before?.net?.received),txDelta=delta(net?.sent,before?.net?.sent),cpuDelta=delta(cpuMicros,before?.cpuMicros);
  const totals=this.store.setting('resourceTotals',{readBytes:0,writtenBytes:0,receivedBytes:0,sentBytes:0,cpuSeconds:0,since:new Date(now).toISOString()});
  if(before){totals.readBytes+=readDelta||0;totals.writtenBytes+=writeDelta||0;totals.receivedBytes+=rxDelta||0;totals.sentBytes+=txDelta||0;totals.cpuSeconds+=(cpuDelta||0)/1e6;this.store.setSetting('resourceTotals',totals);}
  this.previous={at:now,cpu,cpuMicros,io,net};
  const cpuTotal=before?cpu.total-before.cpu.total:0;
  this.cached={at:now,sampleSeconds:seconds,scope:cgroup?'Container / cgroup':'Native host + Node process',cpu:{name:os.cpus()[0]?.model,threads:os.cpus().length,availableCores:quota,hostPercent:cpuTotal?100*(1-(cpu.idle-before.cpu.idle)/cpuTotal):null,workloadPercent:seconds&&cpuDelta!==null?Math.min(100,cpuDelta/(seconds*1e6*quota)*100):null,workloadScope:cgroup?'Container including workers':'Node process only (workers excluded)'},memory:{hostNote:process.platform==='darwin'?'Occupied RAM includes caches; not memory pressure':'Used estimate excludes available memory',hostTotalBytes:os.totalmem(),hostUsedBytes:mem.MemAvailable?os.totalmem()-mem.MemAvailable*1024:os.totalmem()-os.freemem(),workloadUsedBytes:memoryRaw!==null?Number(memoryRaw):process.memoryUsage().rss,workloadLimitBytes:memoryLimit,scope:cgroup?'Container including workers and cache':'Node resident memory; system memory shown separately'},io:io?{readBytes:io.read,writtenBytes:io.write,readBytesPerSecond:seconds&&readDelta!==null?readDelta/seconds:null,writeBytesPerSecond:seconds&&writeDelta!==null?writeDelta/seconds:null,scope:native?'Host storage drivers (all applications)':ioRaw!==null?'Container block I/O (may exclude network mounts / cache hits)':'Node process physical disk I/O'}:null,network:net?{receivedBytes:net.received,sentBytes:net.sent,receiveBytesPerSecond:seconds&&rxDelta!==null?rxDelta/seconds:null,sendBytesPerSecond:seconds&&txDelta!==null?txDelta/seconds:null,scope:'Visible network namespace; may include other host traffic'}:null,disk,gpu,totals,notes:['Memory values are occupancy, not memory read/write bandwidth.','Unavailable sensors are shown as unavailable, never as zero.','macOS counters use IOKit and netstat when accessible; Apple GPU memory is shared RAM, not dedicated VRAM.','Totals persist for observed counter deltas; time while the server is stopped is not counted.']};return this.cached;
 }
 start(){void this.sample().catch(()=>{});this.timer=setInterval(()=>this.sample().catch(()=>{}),5000);this.timer.unref();}
 stop(){clearInterval(this.timer);}
}
module.exports={ResourceMonitor,pairs,ioCounters,networkCounters};
