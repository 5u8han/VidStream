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
 window.StreamLibraryMap={mount};
})();
