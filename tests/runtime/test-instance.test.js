"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture,freePort}=require("../support/runtime.js");const {prepare}=require("../../tools/create-test-instance.js");
const {readRuntimeConfig}=require("../../internal/instance/config.js");const {resolveActiveGeneration}=require("../../internal/publication/generations.js");
test("test instance copies only immutable published files and cannot overwrite production or source",async t=>{
  const f=await fixture(t);await f.build();f.publish();const config=path.join(f.config.instanceRoot,"config.json"),out=path.join(f.root,"isolated"),port=await freePort();
  const before=fs.readFileSync(f.config.activeGenerationPath);const source=resolveActiveGeneration(f.config.instanceRoot);
  fs.writeFileSync(path.join(source.generationRoot,"not-a-database.txt"),"synthetic unrelated output");
  const prepared=prepare(config,out,port),copy=resolveActiveGeneration(out);
  assert.equal(prepared.state,"READY");assert.equal(copy.catalogFacts.sha256,source.catalogFacts.sha256);assert.equal(copy.searchFacts.sha256,source.searchFacts.sha256);
  assert.equal(fs.existsSync(path.join(copy.generationRoot,"not-a-database.txt")),false);assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath),before);
  assert.equal(readRuntimeConfig(path.join(out,"config.json")).deployment,"staging");assert.equal(readRuntimeConfig(path.join(out,"config.json")).host,"127.0.0.1");
  assert.throws(()=>prepare(config,out,port));assert.throws(()=>prepare(config,f.bindings.pixiv,port));assert.throws(()=>prepare(config,path.join(f.root,"bad"),8081));
});
