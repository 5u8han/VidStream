(function () {
 'use strict';
 var config=JSON.parse(document.getElementById('app').dataset.config||'{}'),dialog,content,status,returnFocus,poll,adapter={},pendingUI={},saveTimer;
 try{pendingUI=JSON.parse(localStorage.getItem('stream-ui-pending')||'{}');}catch(_){}
 var deviceKeys=['stream-data-saver','stream-max-previews','stream-preview-source','stream-viewer-blur','stream-video-stats','stream-effects','stream-saved-filters','stream-pinned-actions'];deviceKeys.forEach(function(k){delete pendingUI[k];});
 Object.entries(Object.assign({},config.savedUI||{},pendingUI)).filter(function(entry){return !deviceKeys.includes(entry[0]);}).forEach(function(entry){try{localStorage.setItem(entry[0],entry[1]);}catch(_){}});
 try{var theme=localStorage.getItem('stream-theme');if(theme&&theme!=='system')document.documentElement.dataset.theme=theme;else document.documentElement.removeAttribute('data-theme');var density=localStorage.getItem('stream-density');if(density)document.documentElement.dataset.density=density;}catch(_){}
 window.StreamActivity.setEnabled(config.tracking!==false);
 function node(tag,text,parent){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(parent)parent.appendChild(e);return e;}
 function button(text,parent,fn){var b=node('button',text,parent);b.type='button';b.addEventListener('click',function(){Promise.resolve().then(fn).catch(error);});return b;}
 function error(e){if(status)status.textContent=e.message;}
 async function api(url,body){var r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j;}
 function select(label,values,parent){var wrap=node('label',label,parent),s=node('select',undefined,wrap);s.setAttribute('aria-label',label);values.forEach(function(v){var o=node('option',v[1],s);o.value=v[0];});return s;}
 function stepBack(){if(window.StreamNavigation)window.StreamNavigation.back();else if(dialog?._back)dialog._back();}
 function enter(id,back,forward){if(window.StreamNavigation)return window.StreamNavigation.enter(id,{back:back,forward:forward});return true;}
 function shell(title){
  if(dialog)dialog.remove();clearInterval(poll);returnFocus=document.activeElement;
  dialog=node('dialog');var current=dialog;dialog.className='stream-settings';dialog.setAttribute('aria-label',title);
  var head=node('header',undefined,dialog),back=button('Close',head,stepBack);back.className='settings-nav-back';
  var heading=node('h2',title,head);dialog._heading=heading;dialog._backButton=back;
  content=node('div',undefined,dialog);status=node('p','',dialog);status.setAttribute('role','status');
  dialog._back=function(){if(current.open)current.close();};
  dialog.addEventListener('cancel',function(e){e.preventDefault();stepBack();});
  dialog.addEventListener('close',function(){clearInterval(poll);if(window.StreamNavigation?.has('settings'))window.StreamNavigation.leave('settings');returnFocus?.focus({preventScroll:true});});
  dialog.addEventListener('click',function(e){var bounds=current.getBoundingClientRect();if(e.target===current&&(e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom))stepBack();});
  document.body.appendChild(dialog);dialog.showModal();
  enter('settings',function(){if(current.open)current.close();},function(){if(!current.isConnected)return false;dialog=current;if(!current.open)current.showModal();current._resumePolling?.();});
  return content;
 }
 async function jobs(parent,item,video){
  var offset=parent._offset||0;var data=await api('/api/enhancements?offset='+offset+(item?'&item='+encodeURIComponent(item.id):''));if(!parent.isConnected||!parent.closest('dialog')?.open)return;var snapshot=JSON.stringify(data);if(parent._snapshot===snapshot)return;parent._snapshot=snapshot;parent.replaceChildren();
  node('p',data.total+' saved jobs · showing '+(data.jobs.length?offset+1:0)+'–'+(offset+data.jobs.length),parent);
  if(!data.jobs.length)node('p','No enhancement jobs yet. Open a video and choose Enhance video to start.',parent);
  data.jobs.forEach(function(j){var card=node('article',undefined,parent);node('h3',j.filename,card);node('p',j.state+' · '+j.phase+' · '+Math.round(j.progress*100)+'%',card);
   node('small',j.options.smoothing+' · '+j.options.upscale,card);
   if(j.error)node('p',j.error,card);
   if(j.state==='completed'){
    if(video)button('Play enhanced video',card,function(){video.dataset.sourceKind='enhanced';video.dataset.sourceFps=String(j.options.fps||'');video.src=j.url;video.play().catch(function(){});window.StreamActivity.record(item,'enhanced-play');stepBack();});
    var a=node('a','Download enhanced video',card);a.href=j.url+'?download=1';a.setAttribute('download','');
   }else button(j.state==='paused'?'Resume':'Pause',card,async function(){await api('/api/enhancements/'+j.id,{action:j.state==='paused'?'resume':'pause'});await jobs(parent,item,video);});
  });
  if(offset>0)button('Newer jobs',parent,function(){parent._offset=Math.max(0,offset-50);return jobs(parent,item,video);});
  if(data.nextOffset!==null)button('Older jobs',parent,function(){parent._offset=data.nextOffset;return jobs(parent,item,video);});
 }
 async function open(){
  if(dialog?.open)return;
  var body=shell('Settings'),current=dialog,tabs=node('nav',undefined,body),panes={},buttons={},active=null;tabs.className='settings-categories';tabs.setAttribute('aria-label','Settings categories');
  var descriptions={View:'Layout, player blur and playback details',Enhancement:'Hardware, models and processing',Jobs:'Saved enhancements and clean-library exports',Maintenance:'Work priorities, storage, backups and recovery',History:'Activity recording and recent views',Security:'Sign-in, access and account'};
  function show(name){active=name;tabs.hidden=!!name;Object.entries(panes).forEach(function(entry){entry[1].hidden=entry[0]!==name;});current._heading.textContent=name||'Settings';current._backButton.textContent=name?'← Settings':'Close';current._backButton.setAttribute('aria-label',name?'Back to settings':'Close settings');current.scrollTop=0;if(name){panes[name].tabIndex=-1;panes[name].focus({preventScroll:true});}else buttons[current._lastSection||'View']?.focus({preventScroll:true});}
  function root(){show(null);current._back=function(){if(current.open)current.close();};}
  function tab(name){var pane=node('section',undefined,body);pane.className='settings-pane';pane.hidden=true;pane.id='settings-'+name.toLowerCase();pane.setAttribute('aria-label',name);panes[name]=pane;var b=button('',tabs,function(){if(enter('settings-section',root,function(){show(name);current._back=root;})===false)return;current._lastSection=name;show(name);current._back=root;});b.className='settings-category';node('strong',name,b);node('small',descriptions[name],b);var arrow=node('span','›',b);arrow.setAttribute('aria-hidden','true');b.setAttribute('aria-controls',pane.id);buttons[name]=b;return pane;}
  var view=tab('View');node('p','Choose a look and layout. Press / for settings.',view);
  button('Randomly enlarge previews',view,function(){adapter.randomize?.();status.textContent='New pattern saved across the library.';});button('Uniform preview sizes',view,function(){adapter.uniform?.();status.textContent='Random enlargement disabled.';});
  Array.from(view.querySelectorAll('button')).slice(0,2).forEach(function(b,i){b.dataset.randomSize=i===0?'on':'off';try{b.classList.toggle('selected',(localStorage.getItem('stream-random-enabled')==='1')===(i===0));}catch(_){}});
  var theme=select('Theme',[['system','System'],['light-table','Light Table'],['darkroom','Darkroom'],['golden-hour','Golden Hour'],['contact-sheet','Contact Sheet']],view);
  var density=select('Grid density',[['small','Small'],['medium','Medium'],['large','Large']],view),fit=select('Media fit',[['contain','Show the whole image'],['cover','Fill each tile']],view);
  var blurLabel=node('label','Viewer background blur: ',view),blurValue=node('span','',blurLabel),blur=node('input',undefined,blurLabel);blur.type='range';blur.min='0';blur.max='30';blur.step='1';blur.className='settings-range';
  try{theme.value=localStorage.getItem('stream-theme')||'system';density.value=localStorage.getItem('stream-density')||'medium';fit.value=localStorage.getItem('stream-media-fit')||'contain';}catch(_){}
  try{blur.value=localStorage.getItem('stream-viewer-blur')||'10';}catch(_){blur.value='10';}blurValue.textContent=blur.value+' px';
  theme.onchange=function(){adapter.theme?.(theme.value);};density.onchange=function(){adapter.density?.(density.value);};fit.onchange=function(){adapter.fit?.(fit.value);};
  blur.oninput=function(){blurValue.textContent=blur.value+' px';adapter.viewerBlur?.(blur.value);};
  var statsLabel=node('label','Show Stats for nerds in video player ',view),stats=node('input',undefined,statsLabel);statsLabel.className='option-chip';stats.type='checkbox';
  try{stats.checked=localStorage.getItem('stream-video-stats')==='1';}catch(_){}
  stats.onchange=function(){adapter.videoStats?.(stats.checked);};
  if(!config.isAdmin){node('p','Sign in to manage enhancement and the library.',view);return;}
  var enhancement=tab('Enhancement'),saved=tab('Jobs'),maintenance=tab('Maintenance'),historyPane=tab('History'),security=tab('Security');window.StreamWorkbench.maintenance(maintenance);
  var data=await api('/api/settings');if(!body.isConnected)return;window.StreamActivity.setEnabled(data.tracking);
  node('h3','Server enhancement',enhancement);node('p','Your server does the work. Playback quality and Data saver stay specific to each browsing device. Phones and tablets control jobs and play their results. A job processes the original once, saves a separate result, and stops. It does not repeatedly enhance its own output.',enhancement);
  var enabledLabel=node('label','Enable enhancement on this server ',enhancement);enabledLabel.className='option-chip';var enabled=node('input',undefined,enabledLabel);enabled.type='checkbox';enabled.checked=data.enhancementEnabled;
  enabled.onchange=async function(){try{await api('/api/settings',{enhancementEnabled:enabled.checked});status.textContent=enabled.checked?'Enhancement enabled. Queued work can continue.':'Enhancement suspended. Completed checkpoints are retained.';}catch(e){error(e);}};
  var hardware=node('article',undefined,enhancement);hardware.className='hardware-allocation';node('h3','Resources available to this server',hardware);node('p',data.hardware.cpu,hardware);
  node('p','OS / VM RAM: '+(data.hardware.osMemoryGiB??data.hardware.detectedMemoryGiB)+' GiB',hardware);
  node('p','Container RAM ceiling: '+(data.hardware.memoryLimitGiB===null?'No additional ceiling detected':data.hardware.memoryLimitGiB!==undefined?data.hardware.memoryLimitGiB+' GiB':'Unavailable'),hardware);
  node('p','Available CPU capacity: '+(data.hardware.effectiveCores??data.hardware.threads)+' cores'+(data.hardware.logicalThreads?' · '+data.hardware.logicalThreads+' OS-visible threads':''),hardware);
  if(data.hardware.scope)node('small',data.hardware.scope,hardware);
  var guidance=node('details',undefined,hardware);node('summary','Allocate more resources / GPU access',guidance);
  guidance.addEventListener('toggle',function(){if(!current.open)return;if(guidance.open){if(window.StreamNavigation?.has('settings-detail'))return;if(enter('settings-detail',function(){guidance.open=false;},function(){guidance.open=true;})===false)guidance.open=false;}else if(window.StreamNavigation?.has('settings-detail'))window.StreamNavigation.leave('settings-detail');});
  (data.hardware.guidance||['Docker or virtual-machine resource limits are configured on the server. This menu cannot grant hardware access.']).forEach(function(note){node('p',note,guidance);});
  if(data.hardware.gpuNote)node('p',data.hardware.gpuNote,guidance);
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
  node('h3','Saved jobs',saved);var list=node('div',undefined,saved);await jobs(list);if(!body.isConnected)return;
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
  if(!body.isConnected)return;
  current._resumePolling=function(){clearInterval(poll);poll=setInterval(function(){if(!current.open)return;if(active==='Jobs'){jobs(list).catch(error);api('/api/clean-library').then(exportState).catch(error);}if(active==='Enhancement')refreshRuntime().catch(error);},4000);};if(current.open)current._resumePolling();
 }
 async function enhance(item,video){
  if(dialog?.open)return;
  var body=shell('Enhance video');await window.StreamWorkbench.enhance(body,item,video,stepBack);
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
