'use strict';
const {isAdmin}=require('../auth');
const {readJsonBody}=require('../body');
const ACTIONS=new Set(['hover','open','close','play','pause','ended','seek','watch','download','enhanced-play']);
const TOKEN=/^[a-zA-Z0-9_-]{8,80}$/;
const UI_KEYS=new Set(['stream-theme','stream-density','stream-video-scale','stream-max-previews','stream-tile-size','stream-preview-source','stream-media-fit','stream-data-saver','stream-random-seed','stream-random-enabled','stream-artist-outlines','stream-artist-palette']);
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
function settingsHandlers(cfg,db) {
 const store=db.store;
 return {
  get:(req,res)=>{if(!admin(cfg,req,res))return;json(res,200,{security:{mode:cfg.localPassword?'Saved owner passphrase':cfg.ldapUrl?'LDAP / configured credentials':'Configured password',username:cfg.localUsername||cfg.adminUsername||null,requireLogin:cfg.requireLogin},ui:store.setting('ui',{}),tracking:store.setting('tracking',true)});},
  update:async(req,res)=>{
   if(!admin(cfg,req,res)||!mutation(req,res))return;
   try{const body=await readJsonBody(req,16384);
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Settings must be an object');
    if(Object.keys(body).some(key=>!['ui','tracking','requireLogin'].includes(key)))throw Error('Unsupported settings field');
    if(body.requireLogin!==undefined&&typeof body.requireLogin!=='boolean')throw Error('Invalid access setting');
    if(body.tracking!==undefined&&typeof body.tracking!=='boolean')throw Error('Invalid history setting');
    if(body.ui!==undefined){if(!body.ui||typeof body.ui!=='object'||Array.isArray(body.ui))throw Error('Invalid view preferences');const values=store.setting('ui',{});for(const [key,value] of Object.entries(body.ui)){if(!UI_KEYS.has(key)||typeof value!=='string'||value.length>100)throw Error('Invalid view preference');values[key]=value;}store.setSetting('ui',values);}
    if(body.tracking!==undefined){if(typeof body.tracking!=='boolean')throw Error('Invalid history setting');store.setSetting('tracking',body.tracking);}
    if(body.requireLogin!==undefined){store.setSetting('requireLogin',body.requireLogin);cfg.requireLogin=body.requireLogin;}
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
 };
}
module.exports={settingsHandlers,validateEvent};
