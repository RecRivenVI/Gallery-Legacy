"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createProgressWriter}=require("../../internal/indexing/progress.js");

test("normal phase writes are visible before the next synchronous SQLite stage",async()=>{
  const saved=[],p=createProgressWriter("synthetic",{write:(_,v)=>saved.push(v.state)});
  p.enqueue({state:"VALIDATING"});p.enqueue({state:"BUILDING_SEARCH"});
  assert.deepEqual(saved,["VALIDATING","BUILDING_SEARCH"]);
  await p.flush();assert.equal(p.stats().pending,false);
});
test("progress coalesces transient sharing failures and persists the latest terminal state",async()=>{
  const saved=[];let attempts=0;
  const p=createProgressWriter("synthetic",{write:(_,v)=>{if(++attempts<3)throw Object.assign(new Error("busy"),{code:"EPERM"});saved.push(v);},delay:()=>Promise.resolve()});
  p.enqueue({state:"SCANNING",count:1});p.enqueue({state:"READY",count:2});await p.flush();
  assert.deepEqual(saved.at(-1),{state:"READY",count:2});assert.equal(p.stats().retries,2);
});
test("persistent progress failure is reported, not applied to publication writes",async()=>{
  const p=createProgressWriter("synthetic",{write:()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});},delay:()=>Promise.resolve()});
  p.enqueue({state:"SCANNING"});await assert.rejects(p.flush(),{code:"SCAN_STATUS_WRITE_FAILED"});assert.equal(p.stats().osCode,"EACCES");
});
