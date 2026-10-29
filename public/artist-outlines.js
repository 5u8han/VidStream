(function(){
 'use strict';
 function install(grid,options){let mode=options.mode||'off',frame=0,svg=null,active=null,paths=new Map();
  function draw(){frame=0;if(mode==='off'){svg?.remove();svg=null;return;}
   const tiles=[...grid.querySelectorAll('.tile')];if(!tiles.length){svg?.remove();svg=null;return;}
   const bounds=grid.getBoundingClientRect();
   // Layout coordinates exclude the tile's entrance animation transform.
   const rects=tiles.map(tile=>({x:tile.offsetLeft,y:tile.offsetTop,w:tile.offsetWidth,h:tile.offsetHeight,creator:tile._item.creator||'(Unsorted)'}));
   const geometry=window.StreamLayout.outlines(rects);
   if(!svg?.isConnected){svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('artist-outline-layer');svg.setAttribute('aria-hidden','true');grid.appendChild(svg);}
   svg.setAttribute('width',String(bounds.width));svg.setAttribute('height',String(bounds.height));svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);svg.replaceChildren();paths.clear();
   geometry.paths.forEach(p=>{const el=document.createElementNS(svg.namespaceURI,'path');el.setAttribute('d',p.d);el.setAttribute('stroke',options.color(p.creator));el.dataset.creator=p.creator;svg.appendChild(el);paths.set(p.creator,el);});paint();
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function paint(){grid.dataset.artistOutlines=mode;for(const [creator,path] of paths){path.style.opacity=mode==='hover'?(creator===active?'1':'0'):(active?(creator===active?'1':'.32'):'.72');path.classList.toggle('artist-outline-active',creator===active);}}
  function hover(event){const tile=event.target.closest?.('.tile');const next=tile?tile._item.creator||'(Unsorted)':null;if(next!==active){active=next;paint();}}
  grid.addEventListener('pointerover',hover);grid.addEventListener('focusin',hover);grid.addEventListener('pointerleave',()=>{active=null;paint();});grid.addEventListener('focusout',e=>{if(!grid.contains(e.relatedTarget)){active=null;paint();}});
  // Geometry only changes on layout/import; pointer movement only changes opacity.
  new ResizeObserver(schedule).observe(grid);
  new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&n.matches?.('.tile,.sentinel'))))schedule();}).observe(grid,{childList:true});
  return {refresh:schedule,setMode(value){mode=value;grid.dataset.artistOutlines=mode;schedule();},getMode(){return mode;}};
 }
 window.StreamArtistOutlines={install};
})();
