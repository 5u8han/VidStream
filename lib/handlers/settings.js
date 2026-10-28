'use strict';
const {isAdmin}=require('../auth');
const {readJsonBody}=require('../body');
const {hardwareSummary}=require('../ai-manager');
const {serveFile}=require('../serve-file');
const path=require('node:path');
const ACTIONS=new Set(['hover','open','close','play','pause','ended','seek','watch','download','enhanced-play']);
const TOKEN=/^[a-zA-Z0-9_-]{8,80}$/;
const UUID=/^[a-f0-9-]{36}$/;
const UI_KEYS=new Set(['stream-theme','stream-density','stream-video-scale','stream-max-previews','stream-tile-size','stream-preview-source','stream-media-fit','stream-data-saver','stream-random-seed','stream-random-enabled']);
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function admin(cfg,req,res){if(!isAdmin(req,cfg)){json(res,403,{error:'Admin access required'});return false;}return true;}
function mutation(req,res){if(!(req.headers['content-type']||'').startsWith('application/json')||req.headers['sec-fetch-site']==='cross-site'){json(res,415,{error:'Same-origin JSON request required'});return false;}return true;}
function validateEvent(event) {
 if(!event||!TOKEN.test(event.id||'')||!TOKEN.test(event.visitor||'')||!ACTIONS.has(event.action))throw Error('Invalid activity event');
 const time=Date.parse(event.at);if(!Number.isFinite(time)||time>Date.now()+60000)throw Error('Invalid event timestamp');
 const details={};
 for(const key of ['position','seconds'])if(event.details?.[key]!==undefined){const n=event.details[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>86400)throw Error('Invalid activity details');details[key]=n;}
 if(event.action==='watch'&&(!(details.seconds>0)||details.seconds>30))throw Error('Watch heartbeat must be 30 seconds or less');
 return {...event,at:new Date(time).toISOString(),details};
}
function settingsHandlers(cfg,db,queue,ai) {
 const store=db.store;
 return {
  get:async(req,res)=>{if(!admin(cfg,req,res))return;json(res,200,{ui:store.setting('ui',{}),tracking:store.setting('tracking',true),enhancementDevice:store.setting('enhancementDevice','auto'),hardware:await hardwareSummary(),detection:ai.status(),enhancement:queue.models.status(),dataDirectory:cfg.dataDir,workerError:queue.lastError});},
  update:async(req,res)=>{
   if(!admin(cfg,req,res)||!mutation(req,res))return;
   try{const body=await readJsonBody(req,16384);
    if(body.tracking!==undefined&&typeof body.tracking!=='boolean')throw Error('Invalid history setting');
    if(body.enhancementDevice!==undefined&&!['auto','cpu','gpu'].includes(body.enhancementDevice))throw Error('Invalid compute device');
    if(body.ui!==undefined){if(!body.ui||typeof body.ui!=='object'||Array.isArray(body.ui))throw Error('Invalid view preferences');const values=store.setting('ui',{});for(const [key,value] of Object.entries(body.ui)){if(!UI_KEYS.has(key)||typeof value!=='string'||value.length>100)throw Error('Invalid view preference');values[key]=value;}store.setSetting('ui',values);}
    if(body.tracking!==undefined){if(typeof body.tracking!=='boolean')throw Error('Invalid history setting');store.setSetting('tracking',body.tracking);}
    if(body.enhancementDevice!==undefined){if(!['auto','cpu','gpu'].includes(body.enhancementDevice))throw Error('Invalid compute device');store.setSetting('enhancementDevice',body.enhancementDevice);}
    json(res,200,{ok:true});
   }catch(e){json(res,400,{error:e.message});}
  },
  events:async(req,res)=>{
   if(!mutation(req,res))return;
   try{
    const body=await readJsonBody(req,65536);if(!Array.isArray(body.events)||body.events.length>100)throw Error('Send up to 100 events');
    const events=body.events.map(validateEvent),accepted=[],rejected=[];
    for(const event of events){const item=db.get(event.itemId);if(!item||(!isAdmin(req,cfg)&&!item.guest)){rejected.push(event.id);continue;}
     if(store.setting('tracking',true))store.track(item,event);accepted.push(event.id);}
    json(res,200,{accepted,rejected,tracking:store.setting('tracking',true)});
   }catch(e){json(res,400,{error:e.message});}
  },
  activity:(req,res)=>{if(!admin(cfg,req,res))return;const q=new URL(req.url,'http://x').searchParams;const rawBefore=Number(q.get('before'));const before=Number.isSafeInteger(rawBefore)&&rawBefore>0?rawBefore:null;const item=q.get('item')?db.get(q.get('item')):null;if(q.get('item')&&!item)return json(res,404,{error:'Media not found'});json(res,200,{...store.activityPage(before,100,item?store.key(item):null),stats:item?store.activityStats(item):null});},
  jobs:(req,res)=>{if(!admin(cfg,req,res))return;const item=new URL(req.url,'http://x').searchParams.get('item');json(res,200,{jobs:store.jobs().filter(j=>!item||j.itemId===item).map(j=>({...j,url:j.state==='completed'?'/api/enhancements/'+j.id+'/video':null}))});},
  create:async(req,res,params)=>{if(!admin(cfg,req,res)||!mutation(req,res))return;try{const item=db.get(params.id);if(!item)return json(res,404,{error:'Video not found'});json(res,202,{job:await queue.create(item,await readJsonBody(req))});}catch(e){json(res,400,{error:e.message});}},
  control:async(req,res,params)=>{if(!admin(cfg,req,res)||!mutation(req,res))return;try{const body=await readJsonBody(req);if(!UUID.test(params.id)||!['pause','resume'].includes(body.action))throw Error('Invalid job action');json(res,200,{job:queue[body.action](params.id)});}catch(e){json(res,400,{error:e.message});}},
  install:async(req,res)=>{if(!admin(cfg,req,res)||!mutation(req,res))return;try{const body=await readJsonBody(req);json(res,200,await queue.models.install(body.id));}catch(e){json(res,400,{error:e.message});}},
  video:(req,res,params)=>{const job=queue.get(params.id),item=job&&db.get(job.itemId);if(!job||job.state!=='completed'||(!isAdmin(req,cfg)&&!item?.guest))return json(res,404,{error:'Enhanced video not available'});serveFile(req,res,path.join(queue.dir(job.id),'enhanced.mp4'),{cacheForever:false,downloadName:new URL(req.url,'http://x').searchParams.get('download')==='1'?'enhanced-'+job.filename.replace(/\.[^.]+$/,'.mp4'):null});},
 };
}
module.exports={settingsHandlers,validateEvent};
