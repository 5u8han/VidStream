(function(){
 'use strict';
 function bytes(value){if(value==null)return 'Unavailable';var units=['B','KB','MB','GB','TB'],i=0;while(value>=1000&&i<units.length-1){value/=1000;i++;}return value.toFixed(i?1:0)+' '+units[i];}
 function percent(value){return value==null?'Sampling…':value.toFixed(1)+'%';}
 function mount(parent,isOpen){
  var root=document.createElement('section');root.className='resource-panel';parent.appendChild(root);var timer;
  function n(tag,text,p){var e=document.createElement(tag);e.textContent=text;p.appendChild(e);return e;}
  async function update(){if(!isOpen()||!root.isConnected){clearTimeout(timer);return;}if(!document.hidden){try{var r=await fetch('/api/resources');if(!r.ok)throw Error('Sign in to view server statistics');var d=await r.json();if(!root.isConnected)return;root.replaceChildren();n('h3','Live server resources',root);n('p',d.scope+' · updates every 5 seconds · '+new Date(d.at).toLocaleTimeString(),root);var grid=n('div','',root);grid.className='resource-grid';
   function card(title,value,detail){var c=n('article','',grid);n('small',title,c);n('strong',value,c);n('small',detail||'',c);}
   card('Server CPU',percent(d.cpu.hostPercent),d.cpu.name);card('VidStream CPU',percent(d.cpu.workloadPercent),d.cpu.workloadScope+' · '+d.cpu.availableCores+' cores available');
   card('Server RAM',bytes(d.memory.hostUsedBytes)+' / '+bytes(d.memory.hostTotalBytes),d.memory.hostNote+' · '+(d.memory.hostTotalBytes/1073741824).toFixed(0)+' GiB installed');card('VidStream RAM',bytes(d.memory.workloadUsedBytes)+' / '+bytes(d.memory.workloadLimitBytes),d.memory.scope);
   card('Disk read',d.io?bytes(d.io.readBytesPerSecond)+'/s':'Unavailable',d.io?bytes(d.io.readBytes)+' read · '+d.io.scope:'No portable counter on this host');card('Disk written',d.io?bytes(d.io.writeBytesPerSecond)+'/s':'Unavailable',d.io?bytes(d.io.writtenBytes)+' written':'');
   card('Network received',d.network?bytes(d.network.receiveBytesPerSecond)+'/s':'Unavailable',d.network?bytes(d.network.receivedBytes)+' received':'');card('Network sent',d.network?bytes(d.network.sendBytesPerSecond)+'/s':'Unavailable',d.network?bytes(d.network.sentBytes)+' sent':'');
   card('Storage available',bytes(d.disk?.availableBytes),bytes(d.disk?.totalBytes)+' total on data volume');
   d.gpu.forEach(function(g){card(g.name,g.utilizationPercent===null?'Unavailable':percent(g.utilizationPercent),g.unifiedMemory?'Native Apple GPU':(g.powerWatts==null?'Power unavailable':g.powerWatts+' W')+' · '+(g.temperatureC==null?'Temperature unavailable':g.temperatureC+' °C'));card(g.unifiedMemory?'GPU shared memory':'VRAM',bytes(g.usedBytes)+(g.unifiedMemory?' shared':' / '+bytes(g.totalBytes)),'Memory controller load: '+(g.memoryControllerPercent===null?'Unavailable':percent(g.memoryControllerPercent)));});
   if(!d.gpu.length)card('GPU / VRAM','Unavailable','No NVIDIA telemetry exposed. Apple uses shared system memory.');
   n('p','Recorded since '+new Date(d.totals.since).toLocaleDateString()+': '+bytes(d.totals.readBytes)+' read · '+bytes(d.totals.writtenBytes)+' written · '+bytes(d.totals.receivedBytes)+' received · '+bytes(d.totals.sentBytes)+' sent.',root);
   var details=n('details','',root);n('summary','What these measurements include',details);d.notes.forEach(function(note){n('p',note,details);});if(d.network)n('p',d.network.scope,details);
  }catch(e){root.textContent=e.message;}}timer=setTimeout(update,5000);}
  void update();return function(){clearTimeout(timer);};
 }
 window.StreamResources={mount:mount,bytes:bytes};
})();
