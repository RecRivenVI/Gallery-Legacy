"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {fixture}=require("../support/runtime.js");
const {buildSearchIndex}=require("../../internal/search/build.js");
const {QueryIndex}=require("../../internal/search/query.js");
const {hashDatabaseFile}=require("../../internal/catalog/file-hash.js");
function index(file,g){return new QueryIndex(file,{workCount:g.catalogFacts.workCount,catalogSize:g.catalogFacts.sizeBytes,catalogMtimeMs:g.catalogFacts.mtimeMs,catalogSha256:g.catalogFacts.sha256});}
test("incremental Search matches a complete rebuild for unchanged, changed, deleted, short-query and tag facts",async t=>{
  const f=await fixture(t);const a=await f.build();
  const same=path.join(f.config.tempRoot,"same.sqlite");
  const reuse=buildSearchIndex({catalogPath:a.catalogPath,searchIndexPath:same,baselineSearchPath:a.searchIndexPath});
  assert.equal(reuse.reusedWorks,6);assert.equal(reuse.updatedWorks,0);
  f.work("2026-01-01_00-00-00_1",{id:"same",title:"Changed",user:{id:"100",name:"New author"},caption:"短词狗鱼",tags:["new"]});
  fs.rmSync(path.join(f.bindings.pixiv,"freeform-author"),{recursive:true});
  f.work("new-item",{title:"New",tags:["R-18"],caption:"emoji 🧪"});
  const b=await f.build("second"),target=path.join(f.config.tempRoot,"updated.sqlite");
  const report=buildSearchIndex({catalogPath:b.catalogPath,searchIndexPath:target,baselineSearchPath:a.searchIndexPath});
  assert.ok(report.updatedWorks>0);const full=index(b.searchIndexPath,b),incremental=index(target,b);
  try{for(const query of [{},{query:"鱼"},{query:"鱼猫"},{query:"狗鱼"},{query:"🧪"},{query:"New author"},{tag:"R-18"},{tag:"new"},{sort:"title_desc"},{mediaType:"video"}])assert.deepEqual(incremental.workPage(query),full.workPage(query));assert.deepEqual(incremental.authorPage({}),full.authorPage({}));assert.deepEqual(incremental.tagPage({}),full.tagPage({}));}
  finally{full.close();incremental.close();}
  assert.equal(hashDatabaseFile(a.searchIndexPath),a.searchFacts.sha256);
});
test("older immutable Search stays readable and upgrades once instead of unsafe contentless deletion",async t=>{
  const f=await fixture(t),g=await f.build();
  const Database=require("better-sqlite3"),legacy=path.join(f.config.tempRoot,"legacy.sqlite");
  fs.copyFileSync(g.searchIndexPath,legacy);const db=new Database(legacy);
  db.exec("DROP TABLE short_fts; CREATE VIRTUAL TABLE short_fts USING fts5(terms,content='',detail='none',columnsize=0)");db.close();
  const out=path.join(f.config.tempRoot,"upgrade.sqlite"),r=buildSearchIndex({catalogPath:g.catalogPath,searchIndexPath:out,baselineSearchPath:legacy});
  assert.equal(r.buildMode,"full");assert.equal(r.fallbackReason,"baseline_requires_incremental_search_format");
  const q=index(out,g);try{assert.equal(q.workPage({query:"鱼"}).total,1);}finally{q.close();}
});
