'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {pipeline}=require('node:stream/promises'),{Readable,Transform}=require('node:stream');
const {run}=require('./exec');
const {commitFile,digest,atomicJson,verified}=require('./durable-files');
const ASSETS={
 linux:{rife:{url:'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip',hash:'1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68',member:'rife-ncnn-vulkan-20221029-ubuntu/rife-ncnn-vulkan'},esrgan:{url:'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip',hash:'e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96',member:'realesrgan-ncnn-vulkan'}},
 darwin:{rife:{url:'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip',hash:'4a63a1f3c9c715773c57d2ee51df1b315ed20cd6c63103e45c483ecc4400b595',member:'rife-ncnn-vulkan-20221029-macos/rife-ncnn-vulkan'},esrgan:{url:'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip',hash:'e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a',member:'realesrgan-ncnn-vulkan'}},
};
const binary=engine=>engine==='rife'?'rife-ncnn-vulkan':'realesrgan-ncnn-vulkan';
class EnhancementRuntime {
 constructor(cfg){this.root=path.join(cfg.dataDir,'enhancement-runtime',process.platform+'-'+process.arch);this.installing=false;this.progress=null;this.error=null;}
 executable(engine){const local=path.join(this.root,binary(engine));const fsSync=require('node:fs');return fsSync.existsSync(local)?local:binary(engine);}
 available(engine){const r=spawnSync(this.executable(engine),['-h'],{timeout:5000,encoding:'utf8'});return !r.error&&/Usage:/i.test((r.stdout||'')+(r.stderr||''));}
 status(){const supported=process.platform==='darwin'||(process.platform==='linux'&&process.arch==='x64');return {supported,platform:process.platform,architecture:process.arch,installing:this.installing,progress:this.progress,error:this.error,directory:this.root,rife:this.available('rife'),esrgan:this.available('esrgan'),note:supported?'Install once from this menu; tools and models stay on the server.':'Automatic AI runtime installation is available on native macOS and Linux x86-64. CPU optical-flow smoothing remains available here. Docker on Apple Silicon cannot expose the Apple GPU to these tools; run VidStream natively on macOS for GPU enhancement.'};}
 async install(after){if(this.installing)throw Error('Installation already running');if(!this.status().supported)throw Error(this.status().note);this.installing=true;this.error=null;
  this.perform().then(async()=>{if(after){this.progress='Downloading recommended models';await after();}this.progress='Ready';}).catch(e=>{this.error=e.message;}).finally(()=>{this.installing=false;});return this.status();
 }
 async perform(){
  await fs.mkdir(this.root,{recursive:true});const assets=ASSETS[process.platform];
  for(const engine of ['rife','esrgan']){
   const asset=assets[engine],archive=path.join(this.root,engine+'.zip');
   try{const receipt=JSON.parse(await fs.readFile(path.join(this.root,engine+'-receipt.json'),'utf8'));if(receipt.archiveHash===asset.hash&&await verified(this.executable(engine),receipt.binaryHash)&&this.available(engine))continue;}catch{}
   this.progress='Downloading '+engine;
   if(!await verified(archive,asset.hash)){
    const response=await fetch(asset.url,{signal:AbortSignal.timeout(900000)});if(!response.ok)throw Error('Runtime download failed: '+response.status);let bytes=0;
    const limiter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>650*1024*1024?Error('Runtime download exceeds limit'):null,chunk);}});
    const temp=archive+'.partial';await pipeline(Readable.fromWeb(response.body),limiter,require('node:fs').createWriteStream(temp));if(await digest(temp)!==asset.hash)throw Error('Runtime checksum mismatch');await commitFile(temp,archive);
   }
   this.progress='Verifying and installing '+engine;
   // Extract only the fixed, verified executable; never unpack arbitrary archive paths.
   const result=await run('unzip',['-p',archive,asset.member],{encoding:'buffer',maxBuffer:100*1024*1024,timeout:60000});
   const temp=path.join(this.root,binary(engine)+'.partial');await fs.writeFile(temp,result.stdout,{mode:0o755});await fs.chmod(temp,0o755);await commitFile(temp,path.join(this.root,binary(engine)));
   if(!this.available(engine))throw Error(engine+' could not start. Check platform libraries / driver support.');
   await atomicJson(path.join(this.root,engine+'-receipt.json'),{url:asset.url,archiveHash:asset.hash,binaryHash:await digest(this.executable(engine)),installedAt:new Date().toISOString()});
   await fs.rm(archive,{force:true});
  }
  this.progress='Ready';
 }
}
module.exports={EnhancementRuntime,ASSETS};
