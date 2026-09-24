"use strict";
const crypto = require("node:crypto");
const { readJson, writeJson } = require("../instance/files.js");
const { noLinks } = require("../library/io-paths.js");
function createAccessMonitor(instanceId, isLocal, { file = null, now = Date.now } = {}) {
  const clients = new Map(), events = [];
  const idFor = ip => crypto.createHash("sha256").update(instanceId + "\0" + ip).digest("hex").slice(0,16);
  let dirty=false;
  if(file){
    noLinks(file);let saved;try{saved=readJson(file);}catch{saved=null;}
    if(saved?.version===1 && saved.instanceId===instanceId) {
      for(const c of (Array.isArray(saved.clients)?saved.clients:[]).slice(-256)) {
        if(typeof c.address!=="string"||c.address.length>64||c.id!==idFor(c.address)||!Number.isFinite(c.lastSeenAtMs)||c.lastSeenAtMs<now()-30*86400000)continue;
        clients.set(c.id,{id:c.id,address:c.address,local:isLocal(c.address),agent:["Browser","Venera","Other"].includes(c.agent)?c.agent:"Other",active:0,blocked:!isLocal(c.address)&&c.blocked===true,
          ...Object.fromEntries(["requests","errors","bytes","lastSeenAtMs"].map(k=>[k,Number.isSafeInteger(c[k])&&c[k]>=0?c[k]:0]))});
      }
      for(const e of (Array.isArray(saved.events)?saved.events:[]).slice(-200))if(clients.has(e.client)&&/^[a-z-]+$/.test(e.resource)&&["GET","HEAD","POST","OPTIONS"].includes(e.method)&&Number.isSafeInteger(e.status)&&Number.isFinite(e.atMs))events.push({client:e.client,resource:e.resource,method:e.method,status:e.status,atMs:e.atMs,elapsedMs:Math.max(0,Number(e.elapsedMs)||0)});
    }
  }
  function flush(){for(const [id,c] of clients)if(!c.active&&c.lastSeenAtMs<now()-30*86400000){clients.delete(id);dirty=true;}for(let i=events.length-1;i>=0;i--)if(!clients.has(events[i].client)){events.splice(i,1);dirty=true;}if(file&&dirty){noLinks(file);writeJson(file,{version:1,instanceId,clients:[...clients.values()].map(c=>({...c,active:0})),events});dirty=false;}}
  const timer=file?setInterval(()=>{try{flush();}catch{/* Keep requests available; retry next interval. */}},5000):null;timer?.unref();
  function category(url) {
    const p = String(url || "").split("?")[0];
    for (const kind of ["media", "thumbnails", "works", "authors", "tags", "files", "status", "health"])
      if (p.startsWith("/api/v1/" + kind)) return kind;
    return p === "/venera-source.js" ? "venera-source" : p.startsWith("/api/") ? "other-api" : "page-or-asset";
  }
  function begin(req, res) {
    const ip = req.socket.remoteAddress || "unknown";
    const id = idFor(ip);
    if (!clients.has(id)) {
      if (clients.size >= 256) { const oldest = [...clients.values()].filter(c => !c.active && !c.blocked).sort((a,b) => a.lastSeenAtMs-b.lastSeenAtMs)[0]; if (oldest) clients.delete(oldest.id); else return false; }
      clients.set(id, { id, address: ip, local: isLocal(ip), agent: /venera/i.test(req.headers["user-agent"] || "") ? "Venera" : /mozilla/i.test(req.headers["user-agent"] || "") ? "Browser" : "Other", requests: 0, errors: 0, active: 0, bytes: 0, blocked: false, lastSeenAtMs: 0 });
    }
    const c = clients.get(id); c.requests++; c.active++; c.lastSeenAtMs = now(); dirty=true;
    const started = Date.now(); let done = false;
    const end = () => { if(done)return;done=true;c.active--;c.lastSeenAtMs=now();if(res.statusCode>=400)c.errors++;c.bytes+=Number(res.getHeader("content-length")||0);events.push({atMs:now(),client:id,method:req.method,resource:category(req.url),status:res.statusCode,elapsedMs:Date.now()-started});if(events.length>200)events.shift();dirty=true; };
    res.once("finish",end);res.once("close",end);return !c.blocked;
  }
  return { begin, flush, close(){if(timer)clearInterval(timer);try{flush();}catch{/* Best effort telemetry must not block shutdown. */}}, snapshot: () => ({ clients: [...clients.values()].map(c=>({...c})), events: [...events], privacy: "local instance only; events contain no addresses, URLs, queries or bodies; maximum 30 days / 256 clients / 200 events", since: file ? "persisted-history" : "runtime-start" }),
    clear() { events.length=0;for(const [id,c] of clients)if(!c.active&&!c.blocked)clients.delete(id);dirty=true;flush();return {cleared:true}; },
    block(id, blocked) { const c=clients.get(id);if(!c||c.local)throw Object.assign(new Error("Client unavailable or local"),{code:"CLIENT_CONTROL_FORBIDDEN"});c.blocked=!!blocked;dirty=true;flush();return {id,blocked:c.blocked}; } };
}
module.exports={createAccessMonitor};
