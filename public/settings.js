(function () {
 'use strict';
 var config=JSON.parse(document.getElementById('app').dataset.config||'{}'),dialog,content,status,returnFocus,poll,adapter={},pendingUI={},saveTimer;
 try{pendingUI=JSON.parse(localStorage.getItem('stream-ui-pending')||'{}');}catch(_){}
 var deviceKeys=['stream-data-saver','stream-max-previews','stream-preview-source'];deviceKeys.forEach(function(k){delete pendingUI[k];});
 Object.entries(Object.assign({},config.savedUI||{},pendingUI)).filter(function(entry){return !deviceKeys.includes(entry[0]);}).forEach(function(entry){try{localStorage.setItem(entry[0],entry[1]);}catch(_){}});
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
  var offset=parent._offset||0;var data=await api('/api/enhancements?offset='+offset+(item?'&item='+encodeURIComponent(item.id):''));if(!parent.isConnected||!parent.closest('dialog')?.open)return;var snapshot=JSON.stringify(data);if(parent._snapshot===snapshot)return;parent._snapshot=snapshot;parent.replaceChildren();
  node('p',data.total+' saved jobs · showing '+(data.jobs.length?offset+1:0)+'–'+(offset+data.jobs.length),parent);
  if(!data.jobs.length)node('p','No enhancement jobs yet. Open a video and choose Enhance video to start.',parent);
  data.jobs.forEach(function(j){var card=node('article',undefined,parent);node('h3',j.filename,card);node('p',j.state+' · '+j.phase+' · '+Math.round(j.progress*100)+'%',card);
   node('small',j.options.smoothing+' · '+j.options.upscale,card);
   if(j.error)node('p',j.error,card);
   if(j.state==='completed'){
    if(video)button('Play enhanced video',card,function(){video.src=j.url;video.play().catch(function(){});window.StreamActivity.record(item,'enhanced-play');dialog.close();});
    var a=node('a','Download enhanced video',card);a.href=j.url+'?download=1';a.setAttribute('download','');
   }else button(j.state==='paused'?'Resume':'Pause',card,async function(){await api('/api/enhancements/'+j.id,{action:j.state==='paused'?'resume':'pause'});await jobs(parent,item,video);});
  });
  if(offset>0)button('Newer jobs',parent,function(){parent._offset=Math.max(0,offset-50);return jobs(parent,item,video);});
  if(data.nextOffset!==null)button('Older jobs',parent,function(){parent._offset=data.nextOffset;return jobs(parent,item,video);});
 }
 async function open(){
  var body=shell('Settings'),tabs=node('nav',undefined,body),panes={},buttons={},active='View';tabs.className='settings-tabs';tabs.setAttribute('role','tablist');
  function tab(name){var pane=node('section',undefined,body);pane.className='settings-pane';pane.hidden=name!==active;pane.id='settings-'+name.toLowerCase();pane.setAttribute('role','tabpanel');panes[name]=pane;var b=button(name,tabs,function(){active=name;Object.entries(panes).forEach(function(entry){entry[1].hidden=entry[0]!==name;buttons[entry[0]].setAttribute('aria-selected',String(entry[0]===name));buttons[entry[0]].tabIndex=entry[0]===name?0:-1;});});b.id=pane.id+'-tab';b.setAttribute('role','tab');b.setAttribute('aria-controls',pane.id);pane.setAttribute('aria-labelledby',b.id);b.setAttribute('aria-selected',String(name===active));b.tabIndex=name===active?0:-1;buttons[name]=b;return pane;}
  tabs.addEventListener('keydown',function(e){if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();var names=Object.keys(buttons),index=names.indexOf(active);index=e.key==='Home'?0:e.key==='End'?names.length-1:(index+(e.key==='ArrowLeft'?-1:1)+names.length)%names.length;buttons[names[index]].click();buttons[names[index]].focus();});
  var view=tab('View');node('p','Choose a look and layout. Press / for settings.',view);
  button('Randomly enlarge previews',view,function(){adapter.randomize?.();status.textContent='New pattern saved across the library.';});button('Uniform preview sizes',view,function(){adapter.uniform?.();status.textContent='Random enlargement disabled.';});
  Array.from(view.querySelectorAll('button')).slice(0,2).forEach(function(b,i){b.dataset.randomSize=i===0?'on':'off';try{b.classList.toggle('selected',(localStorage.getItem('stream-random-enabled')==='1')===(i===0));}catch(_){}});
  var theme=select('Theme',[['system','System'],['light-table','Light Table'],['darkroom','Darkroom'],['golden-hour','Golden Hour'],['contact-sheet','Contact Sheet']],view);
  var density=select('Grid density',[['small','Small'],['medium','Medium'],['large','Large']],view),fit=select('Media fit',[['contain','Show the whole image'],['cover','Fill each tile']],view);
  try{theme.value=localStorage.getItem('stream-theme')||'system';density.value=localStorage.getItem('stream-density')||'medium';fit.value=localStorage.getItem('stream-media-fit')||'contain';}catch(_){}
  theme.onchange=function(){adapter.theme?.(theme.value);};density.onchange=function(){adapter.density?.(density.value);};fit.onchange=function(){adapter.fit?.(fit.value);};
  if(!config.isAdmin){node('p','Sign in to manage enhancement and the library.',view);return;}
  var enhancement=tab('Enhancement'),saved=tab('Jobs'),historyPane=tab('History'),security=tab('Security');
  var data=await api('/api/settings');if(!body.closest('dialog')?.open)return;window.StreamActivity.setEnabled(data.tracking);
  node('h3','Server enhancement',enhancement);node('p','Your server does the work. Playback quality and Data saver stay specific to each browsing device. Phones and tablets control jobs and play their results. A job processes the original once, saves a separate result, and stops. It does not repeatedly enhance its own output.',enhancement);
  var enabledLabel=node('label','Enable enhancement on this server ',enhancement);enabledLabel.className='option-chip';var enabled=node('input',undefined,enabledLabel);enabled.type='checkbox';enabled.checked=data.enhancementEnabled;
  enabled.onchange=async function(){try{await api('/api/settings',{enhancementEnabled:enabled.checked});status.textContent=enabled.checked?'Enhancement enabled. Queued work can continue.':'Enhancement suspended. Completed checkpoints are retained.';}catch(e){error(e);}};
  node('p',data.hardware.cpu+' · '+data.hardware.detectedMemoryGiB+' GiB visible RAM',enhancement);
  (data.hardware.gpu||[]).forEach(function(g){node('p',g.name+(g.unifiedMemory?' · shares system memory':' · '+Math.round(g.totalVramMiB/1024*10)/10+' GiB VRAM'),enhancement);});
  node('p','Recommended for native M3 Pro and a capable NVIDIA server: RIFE 4.6 for motion; Real-ESRGAN x4plus for realistic upscaling. Animation 2× is a separate choice for cartoons. Start with a short clip and review artifacts before batching.',enhancement);
  var device=select('Processing device',[['auto','Detect on this server'],['cpu','CPU (smoothing only)'],['gpu','Vulkan GPU / native Apple GPU']],enhancement);device.value=data.enhancementDevice;
  device.onchange=async function(){try{await api('/api/settings',{enhancementDevice:device.value});status.textContent='Device saved for the next job or resume.';}catch(e){error(e);}};
  var runtimeInfo=node('p','',enhancement),install=button('Install tools & recommended models',enhancement,async function(){await api('/api/enhancement-runtime/install',{models:true});status.textContent='Installation started on the server. You may close this window.';await refreshRuntime();});
  var modelLabels={};
  data.enhancement.models.forEach(function(m){var card=node('article',undefined,enhancement);node('strong',m.label,card);node('small',m.source,card);modelLabels[m.id]=button(m.installed?'Model installed · verify':'Download model',card,async function(){status.textContent='Downloading '+m.label;await api('/api/enhancement-models/install',{id:m.id});status.textContent='Model saved.';modelLabels[m.id].textContent='Model installed · verify';});});
  function runtimeState(d){var r=d.enhancement.runtime;runtimeInfo.textContent=(r.installing?r.progress:r.error||r.note)+' · RIFE: '+(r.rife?'ready':'missing')+' · Upscaler: '+(r.esrgan?'ready':'missing');install.disabled=r.installing||!r.supported;d.enhancement.models.forEach(function(m){modelLabels[m.id].textContent=m.installed?'Model installed · verify':'Download model';});}
  runtimeState(data);
  async function refreshRuntime(){var d=await api('/api/settings');if(body.isConnected)runtimeState(d);}
  node('h3','Library batch',enhancement);node('p','Queue current videos once. New imports are not automatically queued. Existing jobs with the same settings are reused. Preview a result before applying a model to the whole library.',enhancement);
  var batchSmooth=select('Batch smoothing',[['rife-v4.6','RIFE · 60 fps'],['ffmpeg','Optical flow · 60 fps (no model)'],['none','Original frame rate']],enhancement),batchScale=select('Batch upscaling',[['none','Original resolution'],['realesrgan-x4plus','Realistic 4×'],['realesr-animevideov3','Animation 2×']],enhancement);
  var consent=node('label','I want to process the current video library with these settings ',enhancement),confirm=node('input',undefined,consent);confirm.type='checkbox';
  button('Queue current videos',enhancement,async function(){if(!confirm.checked)throw Error('Check the batch confirmation first.');var result=await api('/api/enhancements/batch',{confirm:true,smoothing:batchSmooth.value,upscale:batchScale.value});status.textContent=result.queued+' videos accepted; '+result.errors.length+' could not be queued.';if(result.errors.length){var details=node('details',undefined,enhancement);node('summary','Videos needing attention',details);result.errors.forEach(function(e){node('p',e.filename+': '+e.error,details);});}});
  node('h3','Saved jobs',saved);var list=node('div',undefined,saved);await jobs(list);
  node('h3','Clean hosting library',saved);node('p','Export the latest matching enhancement for each video. Optionally include original photos and videos without a completed enhancement. Originals and unrelated destination files are never replaced. Export again to include newly finished jobs.',saved);
  var includeLabel=node('label','Include original photos and videos without enhancements ',saved),include=node('input',undefined,includeLabel);include.type='checkbox';include.checked=true;
  var exportInfo=node('p','',saved);function exportState(d){exportInfo.textContent=d.state+' · '+d.done+'/'+d.total+' files · '+d.directory+(d.error?' · '+d.error:'');}exportState(data.export);
  button('Export / resume hosting library',saved,async function(){exportState(await api('/api/clean-library/export',{includeOriginals:include.checked}));status.textContent='Export started. Completed files are retained if interrupted.';});
  node('p','When moving servers: stop the old instance and copy the entire data and cache volumes. Keep backups. AI frames can use much more space than the original video.',saved);
  var trackingLabel=node('label','Record media activity ',historyPane),tracking=node('input',undefined,trackingLabel);tracking.type='checkbox';tracking.checked=data.tracking;
  tracking.onchange=async function(){try{await api('/api/settings',{tracking:tracking.checked});window.StreamActivity.setEnabled(tracking.checked);}catch(e){error(e);}};
  node('p','Intentional hovers, viewer opens, playback and watched time are saved with media identity. Automatic grid previews do not count as viewer opens. Pending on this browser: '+window.StreamActivity.pending()+'.',historyPane);
  var history=node('div',undefined,historyPane),cursor=null,more=button('Load more activity',historyPane,async function(){var page=await api('/api/activity'+(cursor?'?before='+cursor:''));page.events.forEach(function(e){node('p',new Date(e.occurred_at).toLocaleString()+' · '+e.action+' · '+e.path,history);});cursor=page.next;more.disabled=!cursor;});
  node('h3','Access control',security);node('p',data.security.mode+(data.security.username?' · '+data.security.username:''),security);node('p',data.security.requireLogin?'The whole library requires sign-in.':'Signed-out visitors can see items explicitly shared with guests.',security);
  var lockLabel=node('label','Require sign-in for the entire library ',security);lockLabel.className='option-chip';var lock=node('input',undefined,lockLabel);lock.type='checkbox';lock.checked=data.security.requireLogin;
  lock.onchange=async function(){try{await api('/api/settings',{requireLogin:lock.checked});status.textContent=lock.checked?'Library locked to signed-in users.':'Guest-visible items may now be viewed without signing in.';}catch(e){error(e);}};
  node('p','The owner passphrase is hashed on the server. Existing LDAP sign-in remains supported through LDAP_URL and LDAP_BIND_DN_TEMPLATE. For this small private library, the owner account can be shared among your trusted devices.',security);
  button('Sign out',security,async function(){await api('/api/logout',{});location.href='/';});
  if(!body.closest('dialog')?.open)return;
  poll=setInterval(function(){if(active==='Jobs'){jobs(list).catch(error);api('/api/clean-library').then(exportState).catch(error);}if(active==='Enhancement')refreshRuntime().catch(error);},4000);
 }
 async function enhance(item,video){
  var body=shell('Enhance video');node('p',item.filename,body);
  node('p','Create a separate saved version. Processing continues on the server after you close this window. The original stays unchanged.',body);
  var smoothing=select('Smoothing',[['ffmpeg','60 fps · optical flow (CPU, no model)'],['rife-v4.6','60 fps · RIFE AI'],['none','Keep original frame rate']],body);
  var upscale=select('Upscaling',[['none','Original resolution'],['realesrgan-x4plus','Real-ESRGAN 4× · realistic'],['realesr-animevideov3','Real-ESRGAN 2× · animation']],body);
  node('p','Install tools and models from Settings → Enhancement first. Upscaling needs compatible server graphics hardware. Processing may be much slower than playback.',body);
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
 function preference(key,value){if(!config.isAdmin||deviceKeys.includes(key))return;pendingUI[key]=String(value);savePending();clearTimeout(saveTimer);saveTimer=setTimeout(syncPreferences,500);}
 if(Object.keys(pendingUI).length)saveTimer=setTimeout(syncPreferences,500);
 document.addEventListener('keydown',function(e){if(dialog?.open){e.stopImmediatePropagation();return;}if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest('input,textarea,select,[contenteditable="true"]')){e.preventDefault();e.stopImmediatePropagation();open().catch(error);}},true);
 window.StreamSettings={open:function(){open().catch(error);},enhance:function(item,video){enhance(item,video).catch(error);},preference:preference,init:function(value){adapter=value;}};
})();
