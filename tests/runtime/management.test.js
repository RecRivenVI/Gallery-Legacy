"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture}=require("../support/runtime.js");
const {manage}=require("../../internal/runtime/management.js");
const {fullScan}=require("../../internal/indexing/task.js");
const {createRuntimeBootstrap}=require("../../internal/runtime/bootstrap.js");
test("offline Manager scan launch uses the single candidate pipeline and does not deadlock publication",async t=>{
  const f=await fixture(t,{empty:true}),file=path.join(f.config.instanceRoot,"config.json");
  const started=await manage(file,"scan.start",{confirmReadOnly:true});assert.ok(started.pid>0);
  for(let i=0;i<150;i++){const s=JSON.parse(fs.readFileSync(f.config.scanStatusPath));if(!s.running&&!fs.existsSync(path.join(f.config.stateRoot,"scan.lock")))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(JSON.parse(fs.readFileSync(f.config.scanStatusPath)).state,"READY");
  assert.equal(fs.existsSync(path.join(f.config.stateRoot,"scan.lock")),false);
});
test("local configuration validates, revisions conflict, backups restore without changing instance layout",async t=>{
  const f=await fixture(t),file=path.join(f.config.instanceRoot,"config.json");
  const initial=await manage(file,"config.read");assert.equal(initial.platforms.length,9);
  const changed={...initial.value,port:await require("../support/runtime.js").freePort()};
  await assert.rejects(manage(file,"config.save",{value:changed,revision:"wrong",confirm:true}),{code:"CONFIG_REVISION_CHANGED"});
  const saved=await manage(file,"config.save",{value:changed,revision:initial.revision,confirm:true});assert.equal(saved.valid,true);assert.notEqual(saved.revision,initial.revision);
  const backups=await manage(file,"config.backups");assert.equal(backups.items.length,1);
  assert.deepEqual((await manage(file,"config.backup.read",{name:backups.items[0].name})).value,initial.value);
  await assert.rejects(manage(file,"config.validate",{value:{...changed,instanceRoot:path.join(f.root,"elsewhere")}}),{code:"INSTANCE_LAYOUT_CHANGE_REQUIRES_NEW_INSTANCE"});
  await assert.rejects(manage(file,"config.backup.read",{name:"../config.json"}));
});
test("management validates and publishes READY versions, protects live cache and redacts logs",async t=>{
  const f=await fixture(t),file=path.join(f.config.instanceRoot,"config.json");await f.build();f.publish();
  const r=createRuntimeBootstrap({config:f.config});f.cleanup.push(()=>r.close());await r.start();
  await assert.rejects(manage(file,"cache.clear",{confirm:true}),{code:"STOP_RUNTIME_BEFORE_CLEANUP"});
  const checked=await manage(file,"generation.validate",{id:"first"});assert.equal(checked.valid,true);
  const log=path.join(f.config.logsRoot,"sample.log");fs.writeFileSync(log,'{"state":"READY","pid":123,"title":"private sample body"}\nPRIVATE_ERROR\nprivate free text');
  const text=(await manage(file,"logs.read",{name:"sample.log"})).text;assert.ok(!text.includes("private sample body"));assert.ok(!text.includes("private free text"));assert.ok(text.includes("PRIVATE_ERROR"));
  await assert.rejects(manage(file,"logs.read",{name:"../config.json"}));
  const access=await manage(file,"access.read");assert.ok(Array.isArray(access.clients));
  await r.close();fs.mkdirSync(path.join(f.config.cacheRoot,"thumbnails"),{recursive:true});fs.writeFileSync(path.join(f.config.cacheRoot,"thumbnails/a"),"temporary");
  assert.ok((await manage(file,"cache.clear",{confirm:true})).bytes>0);
  const second=await f.build("second");assert.ok(second);
  assert.equal((await manage(file,"generation.publish",{id:"second",confirm:true})).published,true);
  assert.equal((await manage(file,"generation.rollback",{id:"first",confirm:true})).published,true);
});
test("scoped inspection is bounded and read-only, and cancelled build cannot publish",async t=>{
  const f=await fixture(t),file=path.join(f.config.instanceRoot,"config.json");await f.build();f.publish();const before=fs.readFileSync(f.config.activeGenerationPath);
  const checked=await manage(file,"scope.check",{platformId:"pixiv",authorDirectoryName:"100",confirmReadOnly:true});assert.equal(checked.works,5);assert.equal(checked.catalogModified,false);assert.equal(checked.metadataStates.malformed_json,1);
  await assert.rejects(manage(file,"scope.check",{platformId:"pixiv",authorDirectoryName:"../escape",confirmReadOnly:true}));
  fs.writeFileSync(path.join(f.config.stateRoot,"scan-cancel.json"),JSON.stringify({generationId:"cancelled"}));
  await assert.rejects(fullScan(f.config,{generationId:"cancelled",confirmReadOnly:true}),{code:"SCAN_CANCELLED"});
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath),before);
  assert.equal(JSON.parse(fs.readFileSync(f.config.scanStatusPath)).state,"CANCELLED");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.generationsRoot,"cancelled/manifest.json"))).state,"BUILDING");
  const {NODE_FS_IO}=require("../../internal/library/observer.js");let requested=false;
  const io={...NODE_FS_IO,lstat(p){const s=NODE_FS_IO.lstat(p);if(!requested&&path.basename(p)==="metadata.json"){requested=true;fs.writeFileSync(path.join(f.config.stateRoot,"scan-cancel.json"),JSON.stringify({generationId:"cancel-mid"}));}return s;}};
  await assert.rejects(fullScan(f.config,{generationId:"cancel-mid",confirmReadOnly:true,io}),{code:"SCAN_CANCELLED"});
  assert.equal(requested,true);assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath),before);
});
