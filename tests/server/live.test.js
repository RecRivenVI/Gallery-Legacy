"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture}=require("../support/runtime.js");
const {normalizeRuntimeConfig}=require("../../internal/instance/config.js");
const {observePlatformTree}=require("../../internal/library/observer.js");
const {prepareAuthorObservation}=require("../../internal/indexing/preparation.js");
const {ensureLive,openLive,applyLiveBatch}=require("../../internal/catalog/live.js");
const {createRuntimeServer}=require("../../internal/server/http.js");
function candidate(f,author){const tree=observePlatformTree({platformId:"pixiv",observationRoot:f.bindings.pixiv});return prepareAuthorObservation(tree.authors.find(a=>a.authorDirectoryName===author));}
test("HTTP live pages pin Catalog/Search/revision atomically and old media survive unrelated commits",async t=>{
  const f=await fixture(t,{empty:true});f.work("baseline",{title:"Before",tags:["Original"]});const generation=await f.build();f.publish();
  const config=normalizeRuntimeConfig({...f.config,liveUpdates:true});await ensureLive(config,generation);
  const writer=openLive(config,generation,{readonly:false});f.cleanup.push(()=>writer.close());
  const server=createRuntimeServer({config,generation,status:()=>({state:"READY",scan:{state:"IDLE"}})});f.cleanup.push(()=>server.close());await server.start();
  const get=async route=>{const res=await fetch(config.url+route);return {status:res.status,body:await res.json()};};
  const before=(await get("/api/v1/works?pageSize=1")).body;assert.equal(before.data.total,1);assert.equal(before.revision,0);
  const oldMedia=before.data.items[0].cover.url;assert.ok(oldMedia.includes("&k="));
  f.work("incoming",{title:"Stream new",tags:["Streaming"],date:"2030-01-01T00:00:00Z"},undefined,"200");const update=candidate(f,"200");
  const original=server.reader.works;let inserted=false;
  server.reader.works=(...args)=>{if(!inserted){inserted=true;applyLiveBatch(writer.db,{mappedCandidates:update.preparedCandidates,preparedAuthors:[update.preparedAuthor]});}return original(...args);};
  const pinned=(await get("/api/v1/works?pageSize=1")).body;assert.equal(pinned.revision,0);assert.equal(pinned.data.total,1);assert.equal(pinned.data.items[0].title,"Before");
  server.reader.works=original;
  const after=(await get("/api/v1/works?q=Stream&tag=Streaming")).body;assert.equal(after.revision,1);assert.equal(after.data.total,1);assert.equal(after.data.items[0].title,"Stream new");assert.equal(after.generationId,before.generationId);
  const stale=await get("/api/v1/works?rev=0&pageSize=1&cursor="+encodeURIComponent(before.data.cursor));assert.equal(stale.status,409);assert.equal(stale.body.error.code,"CONTENT_CHANGED");
  assert.equal((await fetch(config.url+oldMedia,{method:"HEAD"})).status,200);
  assert.equal((await fetch(config.url+oldMedia.replace(/k=[a-f0-9]+/,"k=wrong"),{method:"HEAD"})).status,409);
  const status=(await get("/api/v1/status")).body;assert.equal(status.data.live.revision,1);assert.equal(status.data.counts.works,2);
});
