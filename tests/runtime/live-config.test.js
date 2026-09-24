"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture}=require("../support/runtime.js");const {normalizeRuntimeConfig}=require("../../internal/instance/config.js");
const {ensureLive}=require("../../internal/catalog/live.js");const {manage}=require("../../internal/runtime/management.js");
test("live mode is explicit, cannot overlap writable data, and reset archives rather than discards live state",async t=>{
  const f=await fixture(t);const g=await f.build();f.publish();
  assert.equal(f.config.liveUpdates,false);
  assert.throws(()=>normalizeRuntimeConfig({...f.config,liveUpdates:"true"}),{code:"LIVE_UPDATES_INVALID"});
  assert.throws(()=>normalizeRuntimeConfig({...f.config,liveUpdates:true,cacheRoot:path.join(f.config.instanceRoot,"live")}),{code:"LIVE_PATH_OVERLAP"});
  const config=normalizeRuntimeConfig({...f.config,liveUpdates:true}),file=path.join(config.instanceRoot,"config.json");
  const raw=JSON.parse(fs.readFileSync(file));raw.liveUpdates=true;fs.writeFileSync(file,JSON.stringify(raw));
  const first=await ensureLive(config,g);const before=fs.readFileSync(config.activeGenerationPath);
  await assert.rejects(manage(file,"live.reset",{}),{code:"CONFIRMATION_REQUIRED"});
  const reset=await manage(file,"live.reset",{confirm:true});assert.equal(reset.checkpoint,g.generationId);assert.ok(fs.existsSync(path.join(config.tempRoot,reset.archive,"catalog.sqlite")));assert.equal(fs.existsSync(first.catalogPath),false);
  assert.deepEqual(fs.readFileSync(config.activeGenerationPath),before);
  const second=await ensureLive(config,g);assert.notEqual(first.epoch,second.epoch);assert.equal(second.revision,0);
});
