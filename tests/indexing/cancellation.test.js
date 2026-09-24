"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");
const {createCancellationCheck}=require("../../internal/indexing/cancellation.js");
const {fixture}=require("../support/runtime.js");
const {publishGeneration}=require("../../internal/publication/generations.js");
test("hot cancellation checks throttle disk reads, ignore old requests, and latch current cancellation",()=>{
  let time=0,reads=0,request={generationId:"old"};
  const check=createCancellationCheck({generationId:"current",read:()=>{reads++;return request;},now:()=>time});
  for(let i=0;i<100000;i++)check();assert.equal(reads,1);
  request={generationId:"current"};time=199;check();assert.equal(reads,1);
  time=200;assert.throws(check,{code:"SCAN_CANCELLED"});assert.equal(reads,2);
  request=null;time=400;assert.throws(check,{code:"SCAN_CANCELLED"});assert.equal(reads,2);
});
test("forced publication check bypasses cache and preserves previous active pointer",async t=>{
  const f=await fixture(t);await f.build("first");f.publish("first");await f.build("second");
  const before=fs.readFileSync(f.config.activeGenerationPath);let request=null;
  const check=createCancellationCheck({generationId:"second",read:()=>request,now:()=>0});check();request={generationId:"second"};check();
  assert.throws(()=>publishGeneration(f.config.instanceRoot,"second",{atomicWriteHooks:{rename(from,to){check.force();fs.renameSync(from,to);}}}),{code:"SCAN_CANCELLED"});
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath),before);
});
