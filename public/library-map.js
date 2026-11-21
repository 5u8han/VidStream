(function(){
 'use strict';
 function mount(parent,options){
  const root=document.createElement('section');root.className='library-map';parent.appendChild(root);
  function node(tag,text,p=root){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;p.appendChild(e);return e;}
  function button(text,p,fn){const b=node('button',text,p);b.type='button';b.onclick=fn;return b;}
  node('h3','Library map');const description=node('p','All indexed media, independent of gallery filters. Rectangle area shows storage or file count.');description.className='map-description';
  const toolbar=node('div',undefined);toolbar.className='map-toolbar';
  function select(label,values){const wrap=node('label',label+' ',toolbar),s=node('select',undefined,wrap);s.setAttribute('aria-label',label);values.forEach(([value,text])=>{const o=node('option',text,s);o.value=value;});return s;}
  const metric=select('Map area',[['bytes','Storage size'],['files','Number of files']]),detail=select('Map detail',[['artists','Artists / folders'],['files','Every media file']]);
  const home=button('Whole library',toolbar,()=>{selected=null;artist.value='';void loadView();});
  const artist=select('Explore artist',[['','Choose an artist…']]);artist.onchange=()=>{selected=artist.value||null;void loadView();};
  const stage=node('div');stage.className='map-stage';const canvas=node('canvas',undefined,stage);canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Treemap of the media library. Use Explore artist and Choose media for keyboard access.');
  const highlight=node('div',undefined,stage);highlight.className='map-highlight';highlight.hidden=true;
  const info=node('div','Loading library map…');info.className='map-inspector';info.setAttribute('aria-live','polite');
  const actions=node('div');actions.className='map-actions';const openGallery=button('Open artist in gallery',actions,()=>{if(selected)options.openArtist(selected);});openGallery.hidden=true;
  const fileLabel=node('label','Choose media ',actions),fileSelect=node('select',undefined,fileLabel);fileSelect.setAttribute('aria-label','Choose media');fileLabel.hidden=true;
  fileSelect.onchange=()=>{if(fileSelect.value)options.openItem(fileSelect.value);};
  let catalog=null,selected=null,files=[],rectangles=[],size={w:0,h:0},loadId=0,hovered=null,abort=null;
  const bytes=n=>window.StreamResources.bytes(n),weight=item=>metric.value==='bytes'?Math.max(1,item.bytes||0):(item.count||1);
  const ctx=canvas.getContext('2d');
  async function request(url){const r=await fetch(url,{signal:abort.signal});const data=await r.json();if(!r.ok)throw Error(data.error||'Map unavailable');return data;}
  async function loadView(){const id=++loadId;abort?.abort();abort=new AbortController();highlight.hidden=true;hovered=null;rectangles=[];
   try{
    if(!catalog){catalog=await request('/api/library-map');if(id!==loadId)return;catalog.creators.sort((a,b)=>a.name.localeCompare(b.name));catalog.creators.forEach(group=>{const o=node('option',group.name+' · '+group.count,artist);o.value=group.name;});}
    files=[];fileSelect.replaceChildren();fileLabel.hidden=true;openGallery.hidden=!selected;home.disabled=!selected;
    if(selected||detail.value==='files'){
     let offset=0;do{info.textContent='Loading media rectangles… '+files.length.toLocaleString();const q=new URLSearchParams({detail:'files',version:String(catalog.version),offset:String(offset)});if(selected)q.set('creator',selected);const page=await request('/api/library-map?'+q);if(id!==loadId)return;files.push(...page.files);offset=page.nextOffset;}while(offset!==null);
    }
    if(selected){fileLabel.hidden=false;const first=node('option','Choose a file to open',fileSelect);first.value='';files.forEach(file=>{const option=node('option',file.name,fileSelect);option.value=file.id;});}
    draw();summary();
   }catch(e){if(e.name==='AbortError'||id!==loadId)return;info.textContent=e.message;const retry=button('Refresh map',info,()=>{catalog=null;selected=null;artist.replaceChildren();const o=node('option','Choose an artist…',artist);o.value='';void loadView();});retry.className='map-retry';}
  }
  function summary(){if(!catalog)return;const group=selected?catalog.creators.find(g=>g.name===selected):null;info.replaceChildren();node('strong',group?group.name:'Whole library',info);node('span',(group?group.count:catalog.totalFiles).toLocaleString()+' files · '+bytes(group?group.bytes:catalog.totalBytes)+' · '+(selected?'Click a rectangle to open its media.':'Click an artist to explore. Use Every media file for a nested file map.'),info);}
  function draw(){if(!catalog||!root.isConnected||!options.isOpen())return;const w=Math.max(1,stage.clientWidth),h=Math.max(280,Math.min(500,w*.57)),ratio=Math.min(2,devicePixelRatio||1);size={w,h};canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);canvas.style.width=w+'px';canvas.style.height=h+'px';ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);rectangles=[];highlight.hidden=true;
   if(!catalog.totalFiles){info.textContent='Import media to populate the library map.';return;}
   if(selected){for(const rect of StreamLayout.treemap(files.map(f=>({...f,value:weight(f)})),2,2,w-4,h-4)){rect.kind='file';drawFile(rect);rectangles.push(rect);}}
   else{
    const grouped=new Map();for(const f of files){if(!grouped.has(f.creator))grouped.set(f.creator,[]);grouped.get(f.creator).push(f);}
    for(const rect of StreamLayout.treemap(catalog.creators.map(g=>({...g,value:weight(g)})),2,2,w-4,h-4)){
     rect.kind='artist';rect.creator=rect.name;drawArtist(rect);
     if(detail.value==='files'){
      const header=rect.w>85&&rect.h>55?22:0;const nested=StreamLayout.treemap((grouped.get(rect.name)||[]).map(f=>({...f,value:weight(f)})),rect.x+2,rect.y+header+2,Math.max(0,rect.w-4),Math.max(0,rect.h-header-4));
      rectangles.push(rect);for(const file of nested){file.kind='file';drawFile(file);rectangles.push(file);}
     }else rectangles.push(rect);
    }
   }
  }
  function fill(rect,color,inset=1){const w=Math.max(0,rect.w-inset*2),h=Math.max(0,rect.h-inset*2);if(w<=0||h<=0)return;const gradient=ctx.createLinearGradient(rect.x,rect.y,rect.x+rect.w,rect.y+rect.h);gradient.addColorStop(0,color);gradient.addColorStop(1,color+'b0');ctx.fillStyle=gradient;ctx.fillRect(rect.x+inset,rect.y+inset,w,h);}
  function text(value,x,y,width){let text=value;while(text.length&&ctx.measureText(text).width>width)text=text.slice(0,-1);if(text!==value)text=text.slice(0,-1)+'…';ctx.fillText(text,x,y);}
  function drawArtist(r){fill(r,options.color(r.name),1);if(r.w<65||r.h<26)return;ctx.save();ctx.beginPath();ctx.rect(r.x+4,r.y+3,r.w-8,r.h-6);ctx.clip();ctx.fillStyle='#13202b';ctx.font='600 12px system-ui';text(r.name,r.x+9,r.y+17,r.w-18);if(r.h>60&&detail.value==='artists'){ctx.font='11px system-ui';text(r.count.toLocaleString()+' files',r.x+9,r.y+35,r.w-18);text(bytes(r.bytes),r.x+9,r.y+50,r.w-18);}ctx.restore();}
  function drawFile(r){fill(r,options.color(r.creator),Math.min(.65,r.w/8,r.h/8));if(r.w>100&&r.h>40){ctx.fillStyle='#13202b';ctx.font='11px system-ui';text(r.name,r.x+6,r.y+17,r.w-12);ctx.font='10px system-ui';text(bytes(r.bytes),r.x+6,r.y+32,r.w-12);}}
  function hit(e){const b=canvas.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top;for(let i=rectangles.length-1;i>=0;i--){const r=rectangles[i];if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)return r;}return null;}
  canvas.addEventListener('pointermove',e=>{const r=hit(e);if(r===hovered)return;hovered=r;highlight.hidden=!r;if(!r){summary();return;}Object.assign(highlight.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px',borderColor:options.color(r.creator)});info.replaceChildren();node('strong',r.name,info);node('span',r.kind==='artist'?r.count+' files · '+bytes(r.bytes):r.creator+' · '+r.type+' · '+bytes(r.bytes),info);});
  canvas.addEventListener('pointerleave',()=>{hovered=null;highlight.hidden=true;summary();});
  canvas.addEventListener('click',e=>{const r=hit(e);if(!r)return;if(r.kind==='file')options.openItem(r.id);else{selected=r.name;artist.value=selected;void loadView();}});
  metric.onchange=()=>{draw();summary();};detail.onchange=()=>void loadView();
  const observer=new ResizeObserver(()=>draw());observer.observe(stage);
  const cleanup=setInterval(()=>{if(!root.isConnected||!options.isOpen()){observer.disconnect();abort?.abort();clearInterval(cleanup);}},1500);
  void loadView();return {root};
 }
 function mountFolders(parent, options) {
  const root = document.createElement('section');
  root.className = 'folder-storage-map';
  parent.appendChild(root);

  function node(tag, text, parentNode = root, className) {
   const element = document.createElement(tag);
   if (text !== undefined) element.textContent = text;
   if (className) element.className = className;
   parentNode.appendChild(element);
   return element;
  }
  function button(label, target, handler) {
   const control = node('button', label, target);
   control.type = 'button';
   control.onclick = handler;
   return control;
  }
  node('p', 'Rectangle area shows the size or number of indexed media files in each folder.', root, 'map-description');
  const toolbar = node('div', undefined, root, 'map-toolbar');
  const label = node('label', 'Map area ', toolbar);
  const metric = node('select', undefined, label);
  node('option', 'Storage size', metric).value = 'bytes';
  node('option', 'File count', metric).value = 'files';
  button('Refresh map', toolbar, () => void load(path, offset));
  const breadcrumbs = node('nav', undefined, root, 'map-toolbar map-breadcrumbs');
  breadcrumbs.setAttribute('aria-label', 'Folder path');
  const status = node('p', 'Loading folder map…', root, 'map-description');
  status.setAttribute('role', 'status');
  const stage = node('div', undefined, root, 'map-stage');
  stage.hidden = true;
  const canvas = node('canvas', undefined, stage);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Folder treemap. Use the folder list below to navigate with the keyboard.');
  const ctx = canvas.getContext('2d');
  const inspector = node('p', '', root, 'map-description map-folder-inspector');
  const list = node('ul', undefined, root, 'map-folder-list');
  list.setAttribute('aria-label', 'Folders and indexed storage');
  const pager = node('div', undefined, root, 'map-toolbar');
  let path = '', offset = 0, branch, rectangles = [], controller, disposed = false;

  const formatBytes = number => window.StreamResources.bytes(number);
  const sizeLabel = row => formatBytes(row.bytes) + ' · ' + row.count.toLocaleString() + ' ' + (row.count === 1 ? 'file' : 'files');
  const color = row => row.direct ? '#b2bdc5' : options.color(row.path);
  const weight = row => metric.value === 'bytes' ? Math.max(1, row.bytes) : Math.max(1, row.count);

  function entries() {
   const folders = branch.children;
   if (!branch.directFiles || branch.offset > 0) return folders;
   return [...folders, { name: 'Media directly in this folder', count: branch.directFiles, bytes: branch.directBytes, direct: true }];
  }

  function draw() {
   if (!branch || !ctx || disposed || stage.hidden || !stage.clientWidth) return;
   const width = stage.clientWidth;
   const height = Math.min(480, Math.max(280, Math.round(width * 0.58)));
   const ratio = Math.min(2, window.devicePixelRatio || 1);
   canvas.width = Math.round(width * ratio);
   canvas.height = Math.round(height * ratio);
   canvas.style.width = width + 'px';
   canvas.style.height = height + 'px';
   ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
   rectangles = window.StreamLayout.treemap(entries().map(row => ({ ...row, value: weight(row) })), 0, 0, width, height);
   for (const rect of rectangles) {
    ctx.fillStyle = color(rect);
    const inset = Math.min(1, rect.w / 5, rect.h / 5);
    ctx.fillRect(rect.x + inset, rect.y + inset, rect.w - 2 * inset, rect.h - 2 * inset);
    if (rect.w < 56 || rect.h < 24) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + 7, rect.y + 3, rect.w - 14, rect.h - 6);
    ctx.clip();
    ctx.fillStyle = '#13202b';
    ctx.font = '600 13px system-ui';
    ctx.fillText(rect.name, rect.x + 7, rect.y + 18);
    if (rect.h >= 43) {
     ctx.font = '11px system-ui';
     ctx.fillText(sizeLabel(rect), rect.x + 7, rect.y + 35);
    }
    ctx.restore();
   }
  }

  function showBranch(data, focus) {
   branch = data;
   path = branch.path;
   offset = branch.offset;
   breadcrumbs.replaceChildren();
   if (path) button('All folders', breadcrumbs, () => void load('', 0, true));
   for (const crumb of branch.breadcrumbs.slice(0, -1)) {
    button(crumb.name, breadcrumbs, () => void load(crumb.path, 0, true));
   }
   const current = node('strong', path ? branch.name : 'All folders', breadcrumbs);
   current.setAttribute('aria-current', 'location');
   current.tabIndex = -1;
   const scoped = (path ? branch.name : 'Whole library') + ' · ' + sizeLabel(branch);
   const range = branch.previousOffset !== null || branch.nextOffset !== null
    ? ' · Showing folders ' + (offset + 1).toLocaleString() + '–' + (offset + branch.children.length).toLocaleString() + ' of ' + branch.folderCount.toLocaleString()
    : '';
   status.textContent = branch.count ? scoped + range : 'Import media to populate the folder map.';
   inspector.textContent = '';
   list.replaceChildren();
   for (const entry of entries()) {
    const row = node('li', undefined, list);
    const marker = node('span', undefined, row, 'map-folder-swatch');
    marker.style.backgroundColor = color(entry);
    marker.setAttribute('aria-hidden', 'true');
    if (entry.direct) node('span', entry.name, row);
    else button(entry.name, row, () => void load(entry.path, 0, true));
    node('span', sizeLabel(entry), row, 'map-folder-size');
   }
   pager.replaceChildren();
   if (branch.previousOffset !== null) button('Previous folders', pager, () => void load(path, branch.previousOffset, true));
   if (branch.nextOffset !== null) button('Next folders', pager, () => void load(path, branch.nextOffset, true));
   stage.hidden = !ctx || !list.children.length;
   draw();
   if (focus) current.focus({ preventScroll: true });
  }

  async function load(nextPath, nextOffset, focus = false) {
   controller?.abort();
   const request = controller = new AbortController();
   status.textContent = 'Loading folder map…';
   root.setAttribute('aria-busy', 'true');
   try {
    const query = new URLSearchParams({ group: 'folders', path: nextPath, offset: nextOffset, metric: metric.value });
    const response = await fetch('/api/library-map?' + query, { signal: request.signal });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Folder map unavailable.');
    if (!disposed && controller === request) showBranch(data, focus);
   } catch (error) {
    if (!disposed && controller === request && error.name !== 'AbortError') status.textContent = error.message;
   } finally {
    if (!disposed && controller === request) root.removeAttribute('aria-busy');
   }
  }

  function hit(event) {
   const bounds = canvas.getBoundingClientRect();
   const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
   return rectangles.find(rect => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
  }
  canvas.addEventListener('pointermove', event => {
   const rect = hit(event);
   const next = rect ? rect.name + ' · ' + sizeLabel(rect) : '';
   if (inspector.textContent !== next) inspector.textContent = next;
   canvas.style.cursor = rect && !rect.direct ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerleave', () => { inspector.textContent = ''; });
  canvas.addEventListener('click', event => {
   const rect = hit(event);
   if (rect && !rect.direct) void load(rect.path, 0, true);
  });
  metric.onchange = () => void load(path, 0);
  const observer = new ResizeObserver(draw);
  observer.observe(stage);
  void load(path, offset);
  return { dispose() { disposed = true; observer.disconnect(); controller?.abort(); } };
 }

 window.StreamLibraryMap={mount,mountFolders};
})();
