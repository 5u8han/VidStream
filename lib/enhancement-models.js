'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {pipeline}=require('node:stream/promises');
const {Readable,Transform}=require('node:stream');
const {atomicJson,commitFile,digest,verified}=require('./durable-files');
const HF='https://huggingface.co/edgetools/realesrgan/resolve/b8b8b5de432a09da4ef74279243dcdd66c82d484/';
const RIFE='https://raw.githubusercontent.com/nihui/rife-ncnn-vulkan/a7532fc3f9f8f008cd6eecd6f2ffe2a9698e0cf7/models/rife-v4.6/';
const MODELS={
  'rife-v4.6':{label:'RIFE 4.6 · AI frame interpolation',engine:'rife',source:'Official RIFE GitHub',license:'MIT',files:['flownet.param','flownet.bin'],base:RIFE},
  'realesrgan-x4plus':{label:'Real-ESRGAN · realistic video 4×',engine:'esrgan',source:'Hugging Face · edgetools mirror of upstream weights',license:'BSD-3-Clause',scale:4,files:['realesrgan-x4plus.param','realesrgan-x4plus.bin'],base:HF},
  'realesr-animevideov3':{label:'Real-ESRGAN · animation 2×',engine:'esrgan',source:'Hugging Face · edgetools mirror of upstream weights',license:'BSD-3-Clause',scale:2,files:['realesr-animevideov3-x2.param','realesr-animevideov3-x2.bin'],base:HF},
};
class EnhancementModels {
 constructor(cfg) { this.root=path.join(cfg.dataDir,'enhancement-models');this.installing=null; }
 dir(id) { if (!Object.hasOwn(MODELS,id)) throw Error('Unknown enhancement model'); return path.join(this.root,id); }
 installed(id) { return MODELS[id].files.every(f=>{try{return fs.statSync(path.join(this.dir(id),f)).size>32;}catch{return false;}}); }
 runtime(engine) {
   const binary=engine==='rife'?'rife-ncnn-vulkan':'realesrgan-ncnn-vulkan';
   const result=spawnSync(binary,['-h'],{timeout:4000,encoding:'utf8'});
   return !result.error && /Usage:/.test((result.stdout||'')+(result.stderr||''));
 }
 status() { return {directory:this.root,installing:this.installing,runtimes:{rife:this.runtime('rife'),esrgan:this.runtime('esrgan')},models:Object.entries(MODELS).map(([id,m])=>({id,...m,base:undefined,installed:this.installed(id),directory:this.dir(id)}))}; }
 async install(id) {
  const dir=this.dir(id),model=MODELS[id];if(this.installing)throw Error('Another model is downloading');this.installing=id;
  try {
   await fs.promises.mkdir(dir,{recursive:true});
   let saved={};try{saved=JSON.parse(await fs.promises.readFile(path.join(dir,'download.json'),'utf8'));}catch{}
   for(const name of model.files) {
    const dest=path.join(dir,name);if(await verified(dest,saved[name]))continue;
    const response=await fetch(model.base+name,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw Error('Model download failed: '+response.status);
    let bytes=0;const limiter=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;cb(bytes>256*1024*1024?Error('Model file too large'):null,chunk);}});
    const temp=dest+'.partial';
    await pipeline(Readable.fromWeb(response.body),limiter,fs.createWriteStream(temp));
    if(bytes<32)throw Error('Incomplete model download');
    await commitFile(temp,dest);saved[name]=await digest(dest);await atomicJson(path.join(dir,'download.json'),saved);
   }
   return this.status();
  } finally {this.installing=null;}
 }
}
module.exports={EnhancementModels,MODELS};
