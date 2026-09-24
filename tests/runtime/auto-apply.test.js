"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { createRuntimeBootstrap } = require("../../internal/runtime/bootstrap.js");
const { hashDatabaseFile } = require("../../internal/catalog/file-hash.js");
const { normalizeRuntimeConfig } = require("../../internal/instance/config.js");
const { fullScan } = require("../../internal/indexing/task.js");
const get = async (f, endpoint) => { const r = await fetch(f.config.url + endpoint); return { status: r.status, body: await r.json() }; };

test("empty instance serves UI/status and automatically adopts the first verified publication", async t => {
  const f=await fixture(t), r=createRuntimeBootstrap({config:f.config});f.cleanup.push(()=>r.close());
  await r.start();
  assert.equal((await fetch(f.config.url)).status,200);
  assert.equal((await get(f,"/api/v1/status")).body.data.libraryReady,false);
  assert.equal((await get(f,"/api/v1/works")).body.data.total,0);
  assert.equal(fs.existsSync(f.config.activeGenerationPath),false);
  await f.build();f.publish();await r.applyPublished();
  assert.equal((await get(f,"/api/v1/works")).body.data.total,6);
  assert.equal(r.status().loadedGenerationId,"first");
  assert.equal(r.status().restartRequired,false);
});

test("READY adoption preserves physical media URLs, refuses mixed/invalid generations, and never writes old files", async t => {
  const f=await fixture(t);const a=await f.build();f.publish();
  const r=createRuntimeBootstrap({config:f.config});f.cleanup.push(()=>r.close());await r.start();
  const page=(await get(f,"/api/v1/works")).body.data;
  const url=page.items.find(w=>w.cover)?.cover.url;
  assert.ok(url.includes("&p="));
  f.work("000-new-first",{});await f.build("second");f.publish("second");await r.applyPublished();
  assert.equal(r.status().loadedGenerationId,"second");
  assert.equal((await get(f,"/api/v1/works")).body.data.total,7);
  assert.equal((await fetch(f.config.url+url,{method:"HEAD"})).status,200);
  assert.equal((await fetch(f.config.url+url,{headers:{Range:"bytes=0-1"}})).status,206);
  assert.equal((await get(f,"/api/v1/works?g=first")).status,409);
  assert.equal(hashDatabaseFile(a.catalogPath),a.catalogFacts.sha256);
  assert.equal(hashDatabaseFile(a.searchIndexPath),a.searchFacts.sha256);
  fs.writeFileSync(f.config.activeGenerationPath,JSON.stringify({generationId:"missing"}));
  await r.applyPublished();
  assert.equal(r.status().loadedGenerationId,"second");
  assert.ok(r.status().applyError);
  assert.equal((await get(f,"/api/v1/works")).body.data.total,7);
});

test("first live scan can finish while the empty Runtime is online and becomes readable without restarting", async t => {
  const f=await fixture(t),config=normalizeRuntimeConfig({instanceRoot:f.config.instanceRoot,sources:f.bindings,port:f.config.port,liveUpdates:true,retention:{enabled:false}});
  const r=createRuntimeBootstrap({config});f.cleanup.push(()=>r.close());await r.start();
  assert.equal((await get(f,"/api/v1/status")).body.data.libraryReady,false);
  const report=await fullScan(config,{confirmReadOnly:true,generationId:"first-live",mode:"incremental"});
  assert.equal(report.state,"READY");assert.equal(report.fallbackToFull,true);
  assert.equal(report.search.indexVersion,5);assert.equal(report.searchBuild.buildMode,"full");
  await r.applyPublished();
  const status=(await get(f,"/api/v1/status")).body.data;
  assert.equal(status.libraryReady,true);assert.equal(status.live.enabled,true);
  assert.equal(status.loadedGenerationId,"first-live");assert.equal(status.restartRequired,false);
  assert.equal((await get(f,"/api/v1/works")).body.data.total,6);
});

test("missing active pointer beside READY data fails closed instead of guessing an empty or latest library", async t => {
  const f=await fixture(t);await f.build();
  const r=createRuntimeBootstrap({config:f.config});
  await assert.rejects(r.start(),{code:"GENERATION_ACTIVE_POINTER_MISSING"});
  assert.equal(fs.existsSync(path.join(f.config.stateRoot,"runtime.lock")),false);
});

test("generation adoption retains the old read context until an in-flight media response finishes", async t => {
  const f=await fixture(t,{empty:true}),size=16*1024*1024;
  f.work("large",{}, {"1.png":Buffer.alloc(size,7)});
  const a=await f.build();f.publish();
  const {createRuntimeServer}=require("../../internal/server/http.js");
  const server=createRuntimeServer({config:f.config,generation:a,status:()=>({}),onScan:()=>{}});
  f.cleanup.push(()=>server.close());await server.start();
  const old=server.reader;
  const page=(await get(f,"/api/v1/works")).body.data;
  const response=await new Promise((resolve,reject)=>require("node:http").get(f.config.url+page.items[0].cover.url,resolve).once("error",reject));
  response.pause();assert.equal(response.statusCode,200);
  const b=await f.build("replacement");server.applyGeneration(b);
  assert.equal(old.db.open,true);
  let bytes=0;await new Promise((resolve,reject)=>{response.on("data",chunk=>bytes+=chunk.length);response.once("end",resolve);response.once("error",reject);response.resume();});
  assert.equal(bytes,size);
  for(let i=0;i<100&&old.db.open;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(old.db.open,false);
  assert.equal((await get(f,"/api/v1/works")).body.data.total,1);
});
