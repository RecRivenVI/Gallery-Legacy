"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{EventEmitter}=require("node:events");
const {fixture}=require("../support/runtime.js");
const {runValidation,operation}=require("../../internal/runtime/validation.js");
const {manage}=require("../../internal/runtime/management.js");
const {createRuntimeBootstrap}=require("../../internal/runtime/bootstrap.js");
const {rotatingLog}=require("../../internal/runtime/logging.js");
const {createAccessMonitor}=require("../../internal/server/access.js");
const {orphanCache}=require("../../internal/runtime/orphan-cache.js");
const {createThumbnailCache}=require("../../internal/media/thumbnails.js");
const {acquireOwnership}=require("../../internal/instance/ownership.js");
const {writeJson}=require("../../internal/instance/files.js");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test("selective diagnostics retain physical works, filter private findings, export, cancel and purge",async t=>{
  const f=await fixture(t,{empty:true});f.work("empty",undefined,{});f.work("broken","{",{"cover.png":f.PNG});await f.build();f.publish();
  const before=fs.readFileSync(f.config.activeGenerationPath),configPath=path.join(f.config.instanceRoot,"config.json");
  const report=await runValidation(f.config,{confirmReadOnly:true,checks:["metadata.missing","metadata.invalid","media.all_hidden","media.none"]});
  assert.equal(report.state,"COMPLETED");assert.equal(report.works,2);assert.equal(report.counts["metadata.missing"],1);assert.equal(report.counts["metadata.invalid"],1);
  const found=await operation(f.config,configPath,"validation.findings",{id:report.id,check:"metadata.invalid"});assert.equal(found.total,1);assert.equal(found.items[0].severity,"warning");
  const location=await operation(f.config,configPath,"validation.location",{id:report.id,index:found.items[0].index});assert.ok(location.path.startsWith(f.bindings.pixiv));
  for(const format of ["csv","json"]){const exported=await operation(f.config,configPath,"validation.export",{id:report.id,format});assert.ok(fs.statSync(path.join(f.config.reportsRoot,exported.file)).size>0);}
  await assert.rejects(operation(f.config,configPath,"validation.findings",{id:"../escape"}),{code:"VALIDATION_ID_INVALID"});
  let cancelled=false;const stopped=await runValidation(f.config,{confirmReadOnly:true},{onWork(_w,s){if(!cancelled){cancelled=true;writeJson(path.join(f.config.stateRoot,"validation-cancel.json"),{id:s.id});}}});assert.equal(stopped.state,"CANCELLED");
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath),before);
  await operation(f.config,configPath,"validation.purge",{id:report.id,confirm:true});assert.equal(fs.existsSync(path.join(f.config.reportsRoot,report.id+".json")),false);
  const authors=await manage(configPath,"scope.authors",{platformId:"pixiv"});assert.equal(authors.total,1);
  fs.writeFileSync(path.join(f.bindings.pixiv,"stray.txt"),"synthetic");const ignored=await runValidation(f.config,{confirmReadOnly:true,checks:["filesystem.ignored"]});assert.equal(ignored.counts["filesystem.ignored"],1);
  await assert.rejects(manage(configPath,"scan.start",{confirmReadOnly:true,mode:"incremental",platformId:"pixiv",authorDirectoryName:""}),{code:"AUTHOR_DIRECTORY_INVALID"});
});
test("validation start waits for a temporary generation adoption lock",async t=>{
  const f=await fixture(t),configPath=path.join(f.config.instanceRoot,"config.json");
  await f.build("first");f.publish("first");
  const runtime=createRuntimeBootstrap({config:f.config});f.cleanup.push(()=>runtime.close());await runtime.start();
  await f.build("second");f.publish("second");
  const generationCheck=require("../../internal/runtime/generation-check.js"),originalCheck=generationCheck.checkGeneration;
  let applying;
  generationCheck.checkGeneration=async config=>{await delay(500);return originalCheck(config)};
  try{
    applying=runtime.applyPublished();
    for(let i=0;i<100&&!runtime.status().applyingGeneration;i++)await delay(20);
    assert.equal(runtime.status().applyingGeneration,true);
    const started=await manage(configPath,"validation.start",{confirmReadOnly:true});
    assert.ok(["RUNNING","COMPLETED"].includes(started.state));
    let final;
    for(let i=0;i<100;i++){final=await operation(f.config,configPath,"validation.status");if(!final.running)break;await delay(100);}
    assert.equal(final.state,"COMPLETED",JSON.stringify({state:final.state,error:final.error}));
    await applying;
    assert.equal(runtime.status().restartRequired,false);
    const scanLock=await acquireOwnership(f.config,"scan");
    try{await assert.rejects(manage(configPath,"validation.start",{confirmReadOnly:true}),{code:"SCAN_IN_USE"});}
    finally{await scanLock.release();}
  }finally{
    if(applying)await applying;
    generationCheck.checkGeneration=originalCheck;
  }
});
test("rotating logs are size bounded, queryable, and maintain a fixed history",async t=>{
  const f=await fixture(t,{empty:true}),file=path.join(f.config.instanceRoot,"config.json");
  const log=rotatingLog(f.config.logsRoot,"synthetic.log",{maxBytes:128,history:2});for(let i=0;i<20;i++)log.write(JSON.stringify({level:i%2?"error":"info",code:"SYNTHETIC_EVENT",count:i})+"\n");
  const files=fs.readdirSync(f.config.logsRoot);assert.equal(files.length,3);assert.ok(files.every(n=>fs.statSync(path.join(f.config.logsRoot,n)).size<=128));
  const filtered=await manage(file,"logs.read",{name:"synthetic.log",query:"SYNTHETIC_EVENT",level:"error"});assert.ok(filtered.text.includes("error"));
  await assert.rejects(manage(file,"logs.read",{name:"../other.log"}));
  fs.writeFileSync(path.join(f.config.logsRoot,"raw.log"),"synthetic local diagnostic detail\n");
  assert.ok(!(await manage(file,"logs.read",{name:"raw.log"})).text.includes("synthetic local diagnostic detail"));
  assert.ok((await manage(file,"logs.read",{name:"raw.log",raw:true})).text.includes("synthetic local diagnostic detail"));
});
test("local access history survives restart, stays bounded, expires, and stores no query or body",async t=>{
  const f=await fixture(t,{empty:true}),file=path.join(f.config.stateRoot,"synthetic-access.json");let now=Date.now();
  let m=createAccessMonitor("synthetic",()=>false,{file,now:()=>now});
  for(let i=0;i<300;i++){const res=new EventEmitter();res.statusCode=200;res.getHeader=()=>"4";m.begin({socket:{remoteAddress:"192.0.2.1"},headers:{},method:"GET",url:"/api/v1/works?q=DO_NOT_STORE"},res);res.emit("finish");}
  const client=m.snapshot().clients[0];m.block(client.id,true);m.close();assert.ok(!fs.readFileSync(file,"utf8").includes("DO_NOT_STORE"));
  m=createAccessMonitor("synthetic",()=>false,{file,now:()=>now});assert.equal(m.snapshot().clients[0].requests,300);assert.equal(m.snapshot().clients[0].active,0);assert.equal(m.snapshot().clients[0].blocked,true);assert.equal(m.snapshot().events.length,200);
  now+=31*86400000;m.flush();assert.equal(m.snapshot().clients.length,0);m.close();
});
test("orphan cleanup rechecks missing source and retains live and unverifiable old caches",async t=>{
  const f=await fixture(t,{empty:true}),dir=f.work("sample",undefined),source=path.join(dir,"1.png");
  const cache=createThumbnailCache({root:f.config.instanceRoot,cacheRoot:f.config.cacheRoot,tempRoot:f.config.tempRoot,generator:async o=>fs.writeFileSync(o.destinationPath,"synthetic thumbnail")});f.cleanup.push(()=>cache.close());
  const generated=await cache.thumbnailFor({platformId:"pixiv",candidateReal:source,work:{work_id:1n},media:{media_id:1n,relative_path_key:"1.png",filesystem_media_type:"image"},stat:fs.statSync(source,{bigint:true})});
  const unknown=path.join(path.dirname(generated.path),"f".repeat(64)+".webp");fs.writeFileSync(unknown,"unknown old cache");
  assert.equal(orphanCache(f.config).orphanFiles,0);fs.unlinkSync(source);const plan=orphanCache(f.config);assert.equal(plan.orphanFiles,1);assert.equal(plan.unknown,1);
  const applied=orphanCache(f.config,{apply:true});assert.equal(applied.removed,1);assert.equal(fs.existsSync(unknown),true);assert.equal(fs.existsSync(generated.path),false);
});
