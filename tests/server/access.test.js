"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createAccessMonitor}=require("../../internal/server/access.js");
test("access monitor is bounded, redacts request identities and protects local management",()=>{
  const m=createAccessMonitor("test",ip=>ip==="127.0.0.1");
  function request(ip,url="/api/v1/works?q=private-body"){const res=new EventEmitter();res.statusCode=200;res.getHeader=()=>"4";const allowed=m.begin({socket:{remoteAddress:ip},url,method:"GET",headers:{"user-agent":"Venera private identity"}},res);res.emit("finish");return allowed;}
  assert.equal(request("192.0.2.1"),true);const c=m.snapshot().clients[0];m.block(c.id,true);assert.equal(request("192.0.2.1"),false);m.block(c.id,false);assert.equal(request("192.0.2.1"),true);
  request("127.0.0.1");assert.throws(()=>m.block(m.snapshot().clients.find(c=>c.local).id,true));
  for(let i=0;i<300;i++)request("192.0.2.1");const snapshot=m.snapshot();assert.equal(snapshot.events.length,200);assert.ok(!JSON.stringify(snapshot).includes("private"));assert.ok(!JSON.stringify(snapshot.events).includes("192.0.2.1"));assert.equal(snapshot.clients.find(c=>!c.local).address,"192.0.2.1");
});
