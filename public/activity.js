(function () {
  'use strict';
  var prefix='stream-event-', visitor, memory=new Map(), busy=false, enabled=true;
  var recentPositions = new Map(), queuedPositions = new Map(), savingPositions = new Map();
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
  function position(item) {
    var recent = recentPositions.get(item.id) || queuedPositions.get(item.id);
    return recent && recent.version === item.sourceVersion ? recent.position : item.resumePosition || 0;
  }
  var positionPrefix = 'stream-position-';
  function positionKey(id) { return positionPrefix + id; }
  function refreshPositionQueue() {
    try {
      for (var index = 0; index < localStorage.length; index++) {
        var key = localStorage.key(index);
        if (!key?.startsWith(positionPrefix)) continue;
        var id = key.slice(positionPrefix.length);
        var saved = JSON.parse(localStorage.getItem(key));
        if (saved && (!queuedPositions.has(id) || saved.at > queuedPositions.get(id).at))
          queuedPositions.set(id, saved);
      }
    } catch (_) {}
  }
  async function sendPosition(id, finalSend) {
    var saved = queuedPositions.get(id);
    var sending = savingPositions.get(id);
    if (!saved || (sending && (!finalSend || sending === saved))) return;
    var checkpoint = { version: saved.version, position: saved.position, at: saved.at };
    var key = positionKey(id);
    savingPositions.set(id, saved);
    var delivered = false;
    try {
      var response = await fetch('/api/items/' + encodeURIComponent(id) + '/resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkpoint), keepalive: true
      });
      delivered = response.ok || [400, 404, 409].includes(response.status);
      if (delivered && queuedPositions.get(id) === saved) {
        queuedPositions.delete(id);
        try {
          var persisted = JSON.parse(localStorage.getItem(key));
          if (persisted?.at === saved.at) localStorage.removeItem(key);
        } catch (_) {}
      }
    } catch (_) {
    } finally {
      if (savingPositions.get(id) === saved) savingPositions.delete(id);
      if (delivered && queuedPositions.has(id)) void sendPosition(id);
    }
  }
  function savePosition(item, time, finalSend) {
    var checkpoint = { version: item.sourceVersion || null, position: time, at: Date.now() };
    recentPositions.delete(item.id);
    recentPositions.set(item.id, checkpoint);
    if (recentPositions.size > 128) recentPositions.delete(recentPositions.keys().next().value);
    queuedPositions.delete(item.id);
    queuedPositions.set(item.id, checkpoint);
    try { localStorage.setItem(positionKey(item.id), JSON.stringify(checkpoint)); } catch (_) {}
    while (queuedPositions.size > 128) {
      var id = queuedPositions.keys().next().value;
      queuedPositions.delete(id);
      try { localStorage.removeItem(positionKey(id)); } catch (_) {}
    }
    void sendPosition(item.id, finalSend);
  }
  function bind(video,item) {
    var last=performance.now(), seconds=0;
    var initial = position(item);
    var checkpoint = initial;
    var started = false;
    function save(force, ended, finalSend) {
      if (!started || video.readyState < 1 || !Number.isFinite(video.currentTime)) return;
      var time = ended ? 0 : Math.round(video.currentTime * 10) / 10;
      if (force ? time === checkpoint : Math.abs(time - checkpoint) < 10) {
        if (finalSend) void sendPosition(item.id, true);
        return;
      }
      checkpoint = time;
      savePosition(item, time, finalSend);
    }
    function sample() {
      var now=performance.now();
      if(!video.paused&&!video.seeking&&video.readyState>=3&&!document.hidden) {
        seconds+=Math.min(2,(now-last)/1000);
        if (!initial || video.currentTime >= initial - 0.5 || video.currentTime > 1) started = true;
        save(false, false);
      }
      last=now;
      if(seconds>=10)send();
    }
    function send() { if(seconds>.01){record(item,'watch',{seconds:Math.min(30,seconds),position:video.currentTime||0});seconds=0;} }
    var timer=setInterval(sample,1000);
    var listeners={};
    ['play','pause','ended','seeked'].forEach(function(name){
      listeners[name]=function(){
        if (name === 'seeked' || (name === 'pause' && video.currentTime > 0)) started = true;
        sample();
        if (name === 'pause' || name === 'ended') send();
        if (name !== 'play') save(true, name === 'ended' || video.ended);
        record(item,name==='seeked'?'seek':name,{position:video.currentTime||0});
      };
      video.addEventListener(name,listeners[name]);
    });
    function leave(finalSend) { sample(); send(); save(true, video.ended, finalSend); }
    function hidden() { if (document.hidden) leave(true); }
    function pagehide() { leave(true); }
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', hidden);
    return function(){
      leave(false);
      clearInterval(timer);
      window.removeEventListener('pagehide', pagehide);
      document.removeEventListener('visibilitychange', hidden);
      Object.keys(listeners).forEach(function(name){video.removeEventListener(name,listeners[name]);});
    };
  }
  function sync() {
    void flush();
    for (var id of queuedPositions.keys()) void sendPosition(id);
  }
  refreshPositionQueue();
  setInterval(sync,5000);window.addEventListener('online',sync);document.addEventListener('visibilitychange',function(){if(document.hidden)sync();});
  window.StreamActivity={uuid:uuid,record:record,bind:bind,flush:flush,position:position,setEnabled:function(value){enabled=value;},pending:function(){return pending().length;}};
})();
