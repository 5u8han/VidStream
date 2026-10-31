(function () {
  'use strict';
  var prefix='stream-event-', visitor, memory=new Map(), busy=false, enabled=true;
  function uuid(){if(crypto.randomUUID)return crypto.randomUUID();var bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,function(n){return n.toString(16).padStart(2,'0');}).join('');}
  try {visitor=localStorage.getItem('stream-visitor')||uuid();localStorage.setItem('stream-visitor',visitor);}catch(_){visitor=uuid();}
  function pending(){var values=new Map(memory);try{for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key.startsWith(prefix)){var e=JSON.parse(localStorage.getItem(key));values.set(e.id,e);}}}catch(_){}return Array.from(values.values());}
  async function flush() {
    if(busy)return;var batch=pending().slice(0,50);if(!batch.length)return;busy=true;
    try {var r=await fetch('/api/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch}),keepalive:true});
      if(!r.ok)throw Error('Activity sync failed');var data=await r.json();
      (data.accepted||[]).concat(data.rejected||[]).forEach(function(id){memory.delete(id);try{localStorage.removeItem(prefix+id);}catch(_){}});
    }catch(_){}finally{busy=false;}
  }
  function record(item,action,details){if(!enabled||!item)return;var event={id:uuid(),visitor:visitor,itemId:item.id,action:action,at:new Date().toISOString(),details:details||{}};
    try{localStorage.setItem(prefix+event.id,JSON.stringify(event));}catch(_){memory.set(event.id,event);console.warn('Activity cannot be saved on this browser; keep this tab open until it reconnects.');}
    void flush();
  }
  function bind(video,item) {
    var last=performance.now(), seconds=0;
    function sample() { var now=performance.now(); if(!video.paused&&!video.seeking&&video.readyState>=3&&!document.hidden)seconds+=Math.min(2,(now-last)/1000);last=now; if(seconds>=10)send(); }
    function send() { if(seconds>.01){record(item,'watch',{seconds:Math.min(30,seconds),position:video.currentTime||0});seconds=0;} }
    var timer=setInterval(sample,1000);
    var listeners={};['play','pause','ended','seeked'].forEach(function(name){listeners[name]=function(){sample();if(name==='pause'||name==='ended')send();record(item,name==='seeked'?'seek':name,{position:video.currentTime||0});};video.addEventListener(name,listeners[name]);});
    return function(){sample();send();clearInterval(timer);Object.keys(listeners).forEach(function(name){video.removeEventListener(name,listeners[name]);});};
  }
  setInterval(flush,5000);window.addEventListener('online',flush);document.addEventListener('visibilitychange',function(){if(document.hidden)void flush();});
  window.StreamActivity={uuid:uuid,record:record,bind:bind,flush:flush,setEnabled:function(value){enabled=value;},pending:function(){return pending().length;}};
})();
