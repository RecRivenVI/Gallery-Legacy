"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");
const {fixture}=require("../support/runtime.js");
const {createRuntimeBootstrap}=require("../../internal/runtime/bootstrap.js");
const {processIdentity,processIdentityAsync,sameIdentity}=require("../../internal/instance/ownership.js");
test("status does not wait for process lookup, coalesces probes and rejects stale identity",async t=>{
  const f=await fixture(t);let resolveProbe,calls=0;
  const runtime=createRuntimeBootstrap({config:f.config,lookupIdentity:()=>{calls++;return new Promise(resolve=>{resolveProbe=resolve;});}});
  const identity={pid:process.pid,start:"synthetic-start",exe:"synthetic.exe"};
  fs.writeFileSync(f.config.scanStatusPath,JSON.stringify({running:true,state:"SCANNING",pid:process.pid,identity}));
  assert.equal(runtime.status().scan.running,true);
  await Promise.resolve();
  assert.equal(calls,1);
  for(let i=0;i<20;i++)assert.equal(runtime.status().scan.running,true);
  assert.equal(calls,1,"pending CIM probe cannot be duplicated by polling");
  resolveProbe({...identity,start:"reused-pid"});await new Promise(r=>setImmediate(r));
  assert.equal(runtime.status().scan.failure.code,"SCAN_OWNER_EXITED");
  // A later scan must never inherit the previous scan's failed identity check.
  fs.writeFileSync(f.config.scanStatusPath,JSON.stringify({running:true,state:"SCANNING",pid:process.pid,identity:{...identity,start:"new-scan"}}));
  assert.equal(runtime.status().scan.running,true);await Promise.resolve();
  assert.equal(calls,2);resolveProbe(null);await new Promise(r=>setImmediate(r));
});
test("asynchronous Windows identity retains executable and process creation identity",async()=>{
  assert.ok(sameIdentity(await processIdentityAsync(process.pid),processIdentity(process.pid)));
  await assert.rejects(processIdentityAsync(-1),{code:"OWNER_INVALID"});
});
