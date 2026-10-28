(function () {
 'use strict';
 var config=JSON.parse(document.getElementById('app').dataset.config||'{}'),dialog,content,status,returnFocus,poll,adapter={},pendingUI={},saveTimer;
 try{pendingUI=JSON.parse(localStorage.getItem('stream-ui-pending')||'{}');}catch(_){}
 Object.entries(Object.assign({},config.savedUI||{},pendingUI)).forEach(function(entry){try{localStorage.setItem(entry[0],entry[1]);}catch(_){}});
 try{var theme=localStorage.getItem('stream-theme');if(theme&&theme!=='system')document.documentElement.dataset.theme=theme;else document.documentElement.removeAttribute('data-theme');var density=localStorage.getItem('stream-density');if(density)document.documentElement.dataset.density=density;}catch(_){}
 window.StreamActivity.setEnabled(config.tracking!==false);
 function node(tag,text,parent){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(parent)parent.appendChild(e);return e;}
 function button(text,parent,fn){var b=node('button',text,parent);b.type='button';b.addEventListener('click',function(){Promise.resolve().then(fn).catch(error);});return b;}
 function error(e){if(status)status.textContent=e.message;}
 async function api(url,body){var r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j;}
 function select(label,values,parent){var wrap=node('label',label,parent),s=node('select',undefined,wrap);s.setAttribute('aria-label',label);values.forEach(function(v){var o=node('option',v[1],s);o.value=v[0];});return s;}
 function shell(title){
  if(dialog)dialog.remove();clearInterval(poll);returnFocus=document.activeElement;
  dialog=node('dialog');dialog.className='stream-settings';dialog.setAttribute('aria-label',title);
  var head=node('header',undefined,dialog);node('h2',title,head);button('Close',head,function(){dialog.close();});
  content=node('div',undefined,dialog);status=node('p','',dialog);status.setAttribute('role','status');
  dialog.addEventListener('close',function(){clearInterval(poll);returnFocus?.focus();});
  dialog.addEventListener('click',function(e){if(e.target===dialog)dialog.close();});
  document.body.appendChild(dialog);dialog.showModal();return content;
 }
 async function jobs(parent,item,video){
  var data=await api('/api/enhancements'+(item?'?item='+encodeURIComponent(item.id):''));if(!parent.isConnected||!parent.closest('dialog')?.open)return;var snapshot=JSON.stringify(data.jobs);if(parent._snapshot===snapshot)return;parent._snapshot=snapshot;parent.replaceChildren();
  if(!data.jobs.length)node('p','No enhancement jobs yet. Open a video and choose Enhance video to start.',parent);
  data.jobs.forEach(function(j){var card=node('article',undefined,parent);node('h3',j.filename,card);node('p',j.state+' · '+j.phase+' · '+Math.round(j.progress*100)+'%',card);
   node('small',j.options.smoothing+' · '+j.options.upscale,card);
   if(j.error)node('p',j.error,card);
   if(j.state==='completed'){
    if(video)button('Play enhanced video',card,function(){video.src=j.url;video.play().catch(function(){});window.StreamActivity.record(item,'enhanced-play');dialog.close();});
    var a=node('a','Download enhanced video',card);a.href=j.url+'?download=1';a.setAttribute('download','');
   }else button(j.state==='paused'?'Resume':'Pause',card,async function(){await api('/api/enhancements/'+j.id,{action:j.state==='paused'?'resume':'pause'});await jobs(parent,item,video);});
  });
 }
 async function open(){
  var body=shell('Settings');
  node('p','Press / to open settings. View options controls the grid, preview size and theme.',body);
  button('Randomly enlarge video previews',body,function(){adapter.randomize?.();dialog.close();});
  button('Turn off random enlargement',body,function(){adapter.uniform?.();dialog.close();});
  node('h3','View preferences',body);
  var theme=select('Theme',[['system','System'],['light-table','Light Table'],['darkroom','Darkroom'],['golden-hour','Golden Hour'],['contact-sheet','Contact Sheet']],body);
  var density=select('Grid density',[['small','Small'],['medium','Medium'],['large','Large']],body);
  var fit=select('Media fit',[['contain','Show the whole image'],['cover','Fill each tile']],body);
  try{theme.value=localStorage.getItem('stream-theme')||'system';density.value=localStorage.getItem('stream-density')||'medium';fit.value=localStorage.getItem('stream-media-fit')||'contain';}catch(_){}
  theme.onchange=function(){adapter.theme?.(theme.value);};density.onchange=function(){adapter.density?.(density.value);};fit.onchange=function(){adapter.fit?.(fit.value);};
  if(!config.isAdmin){node('p','Sign in as administrator to manage models, jobs and library history.',body);return;}
  var data=await api('/api/settings');if(!body.isConnected)return;
  window.StreamActivity.setEnabled(data.tracking);
  node('h3','Hardware & models',body);
  node('p','Detection and enhancement run on the server. A different phone or laptop only plays the result. Move the persistent data folder when changing the server; completed work follows it.',body);
  node('p',data.hardware.cpu+' · '+data.hardware.threads+' CPU threads · '+data.hardware.detectedMemoryGiB+' GiB available memory',body);
  (data.hardware.gpu||[]).forEach(function(gpu){node('p',gpu.name+' · '+Math.round(gpu.totalVramMiB/1024*10)/10+' GiB graphics memory',body);});
  if(!data.hardware.gpu.length)node('p','No NVIDIA GPU detected here. Other Vulkan devices can be selected explicitly with GPU mode.',body);
  node('p','Object detection device: '+data.detection.effectiveDevice+(data.detection.deviceNote?' · '+data.detection.deviceNote:''),body);
  node('p','Object detection models and enable/disable controls are in the library dashboard.',body);
  var device=select('Enhancement device',[['auto','Auto (detect on this server)'],['cpu','CPU'],['gpu','Vulkan GPU']],body);device.value=data.enhancementDevice;
  device.onchange=async function(){try{await api('/api/settings',{enhancementDevice:device.value});status.textContent='Saved. Applies when a job starts or resumes.';}catch(e){error(e);}};
  node('p','60 fps optical-flow smoothing works with the standard installation. AI models need the optional enhancement runtime. RIFE runtime: '+(data.enhancement.runtimes.rife?'ready':'not installed')+'; Real-ESRGAN runtime: '+(data.enhancement.runtimes.esrgan?'ready':'not installed')+'.',body);
  data.enhancement.models.forEach(function(m){var card=node('article',undefined,body);node('strong',m.label,card);node('p',m.source+' · '+m.license,card);button(m.installed?'Verify / repair model':'Download model',card,async function(){status.textContent='Downloading '+m.label+'…';await api('/api/enhancement-models/install',{id:m.id});status.textContent='Model saved on the server.';});});
  node('h3','Saved enhancement jobs',body);var list=node('div',undefined,body);await jobs(list);if(!body.closest('dialog')?.open)return;poll=setInterval(function(){jobs(list).catch(error);},4000);
  node('h3','Activity & storage',body);
  var tracking=node('label','Record media activity ',body),check=node('input',undefined,tracking);check.type='checkbox';check.checked=data.tracking;
  check.onchange=async function(){try{await api('/api/settings',{tracking:check.checked});window.StreamActivity.setEnabled(check.checked);status.textContent='History setting saved.';}catch(e){error(e);}};
  node('p','Records media identity, intentional hovers, opens, playback, seeks and watched time. Open counts mean viewer opens, not automatic grid previews. Browser activity waiting to sync: '+window.StreamActivity.pending()+'.',body);
  node('p','Persistent storage: '+data.dataDirectory+'. Keep this entire folder and your cache when updating or moving hosts. Stop the old server before copying; never run two hosts against the same data.',body);
  node('p','Verified AI frames and 2-second video segments survive restarts. Unfinished work is retried. Saved sources, frames and outputs can use substantial disk space. Backups are still needed for drive failure.',body);
  var history=node('div',undefined,body),cursor=null;
  var moreHistory=button('Load more activity',body,async function(){var page=await api('/api/activity'+(cursor?'?before='+cursor:''));page.events.forEach(function(e){node('p',new Date(e.occurred_at).toLocaleString()+' · '+e.action+' · '+e.path,history);});cursor=page.next;if(!cursor)moreHistory.disabled=true;status.textContent=cursor?'More history available.':'End of history.';});
 }
 async function enhance(item,video){
  var body=shell('Enhance video');node('p',item.filename,body);
  node('p','Create a separate saved version. Processing continues on the server after you close this window. The original stays unchanged.',body);
  var smoothing=select('Smoothing',[['ffmpeg','60 fps · optical flow (CPU, no model)'],['rife-v4.6','60 fps · RIFE AI'],['none','Keep original frame rate']],body);
  var upscale=select('Upscaling',[['none','Original resolution'],['realesrgan-x4plus','Real-ESRGAN 4× · realistic'],['realesr-animevideov3','Real-ESRGAN 2× · animation']],body);
  node('p','Download AI models in Settings first. Upscaling requires the optional Vulkan runtime and compatible graphics hardware. Processing may be much slower than playback.',body);
  var list=node('div',undefined,body);
  button('Start saved enhancement',body,async function(){await api('/api/items/'+encodeURIComponent(item.id)+'/enhance',{smoothing:smoothing.value,upscale:upscale.value});status.textContent='Job saved.';await jobs(list,item,video);});
  button('Play original',body,function(){video.src=item.urls.full;video.play().catch(function(){});dialog.close();});
  await jobs(list,item,video);if(!body.closest('dialog')?.open)return;poll=setInterval(function(){jobs(list,item,video).catch(error);},3000);
 }
 function savePending(){try{localStorage.setItem('stream-ui-pending',JSON.stringify(pendingUI));}catch(_){}}
 async function syncPreferences(){
  if(!config.isAdmin||!Object.keys(pendingUI).length)return;
  var values=Object.assign({},pendingUI);
  try{await api('/api/settings',{ui:values});Object.keys(values).forEach(function(k){if(pendingUI[k]===values[k])delete pendingUI[k];});savePending();}
  catch(e){console.warn('View preferences waiting to sync:',e.message);}
  if(Object.keys(pendingUI).length)saveTimer=setTimeout(syncPreferences,5000);
 }
 function preference(key,value){if(!config.isAdmin)return;pendingUI[key]=String(value);savePending();clearTimeout(saveTimer);saveTimer=setTimeout(syncPreferences,500);}
 if(Object.keys(pendingUI).length)saveTimer=setTimeout(syncPreferences,500);
 document.addEventListener('keydown',function(e){if(dialog?.open){e.stopImmediatePropagation();return;}if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest('input,textarea,select,[contenteditable="true"]')){e.preventDefault();e.stopImmediatePropagation();open().catch(error);}},true);
 window.StreamSettings={open:function(){open().catch(error);},enhance:function(item,video){enhance(item,video).catch(error);},preference:preference,init:function(value){adapter=value;}};
})();
