"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { buildCatalog } = require("../../internal/indexing/build.js");
test("fresh full pipeline batches across authors and releases bounded preparation results", async (t) => {
  const f = await fixture(t, { empty: true });
  for (let i = 0; i < 24; i++) {
    f.work("work", { title: "Synthetic " + i }, undefined, String(i + 100));
  }
  let commits = 0;
  const result = await buildCatalog({
    catalogPath: path.join(f.config.tempRoot, "pipeline.sqlite"),
    platformRoots: f.bindings,
    batchSize: 50,
    maxPreparationWorkers: 2,
    concurrency: { disks: [] },
    onCommittedBatch: () => {
      commits++;
    },
  });
  assert.equal(result.report.catalogCounts.works, 24);
  assert.equal(
    commits,
    1,
    "full scan must not flush and rewrite every author's work twice",
  );
  assert.ok(result.report.execution.preparation.peakPendingWorks <= 2);
  assert.ok(result.report.execution.writer.peakPendingCandidates <= 50);
});
test("large author uses a bounded parallel preparation window with deterministic final authority",async t=>{
  const f=await fixture(t,{empty:true});
  for(let i=0;i<40;i++)f.work("work-"+String(i).padStart(3,"0"),{id:String(i),title:"Synthetic",date:`2030-02-${String(i%20+1).padStart(2,"0")}T00:00:00Z`,user:{id:"100",name:"Synthetic author"}});
  const result=await buildCatalog({catalogPath:path.join(f.config.tempRoot,"parallel.sqlite"),platformRoots:f.bindings,batchSize:10,maxPreparationWorkers:3,concurrency:{disks:[]}});
  assert.equal(result.report.catalogCounts.works,40);
  assert.ok(result.report.execution.preparation.peakPendingWorks>1);
  assert.ok(result.report.execution.preparation.peakPendingWorks<=3);
  assert.ok(result.report.execution.writer.peakPendingCandidates<=10);
});
