/* Pure geometry shared by the dashboard map and gallery outlines. */
(function(root){
 'use strict';
 const PALETTE=['#ec8c78','#77bde0','#b4a0ef','#8ac69a','#e4bf6e','#e49fc5','#7bc7bd','#a9b8e0','#c6bc8d','#d59c78','#b0c985','#bba2c8'];
 function hash(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
 function color(name,seed='default'){return PALETTE[hash(seed+'|'+name)%PALETTE.length];}
 function treemap(items,x,y,w,h){
  const list=items.filter(i=>Number.isFinite(i.value)&&i.value>0).slice().sort((a,b)=>b.value-a.value||String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const total=list.reduce((sum,i)=>sum+i.value,0);if(!total||w<=0||h<=0)return [];
  const scaled=list.map(i=>({...i,area:i.value/total*w*h})),result=[];let row=[],sum=0,min=Infinity,max=0;
  function score(s,lo,hi,side){return Math.max(side*side*hi/(s*s),s*s/(side*side*lo));}
  function place(){if(!row.length)return;if(w>=h){const width=sum/h;let top=y;for(const i of row){const height=i.area/width;result.push({...i,x,y:top,w:width,h:height});top+=height;}x+=width;w=Math.max(0,w-width);}else{const height=sum/w;let left=x;for(const i of row){const width=i.area/height;result.push({...i,x:left,y,w:width,h:height});left+=width;}y+=height;h=Math.max(0,h-height);}row=[];sum=0;min=Infinity;max=0;}
  for(const item of scaled){const side=Math.min(w,h);if(row.length&&score(sum+item.area,Math.min(min,item.area),Math.max(max,item.area),side)>score(sum,min,max,side))place();row.push(item);sum+=item.area;min=Math.min(min,item.area);max=Math.max(max,item.area);}place();return result;
 }
 // A one-pixel inset keeps every tile border separate, even with zero gutters.
 function outlines(rects){
  const paths=new Map();
  for(const r of rects){
   if(r.w<=2||r.h<=2)continue;
   const x=r.x+1,y=r.y+1,w=r.w-2,h=r.h-2;
   paths.set(r.creator,(paths.get(r.creator)||'')+`M${x} ${y}h${w}v${h}h${-w}Z`);
  }
  return {paths:[...paths].map(([creator,d])=>({creator,d}))};
 }
 const api={color,treemap,outlines,PALETTE};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.StreamLayout=api;
})(typeof window==='undefined'?globalThis:window);
