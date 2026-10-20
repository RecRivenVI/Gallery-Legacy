"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { buildCatalog } = require("../../src/indexing/build.js");
const { updateCatalog } = require("../../src/indexing/incremental.js");
const {
  createPreparationPool,
} = require("../../src/indexing/preparation-pool.js");
const {
  createObservationProducer,
} = require("../../src/library/scan-producer.js");
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
test("large author uses a bounded parallel preparation window with deterministic final authority", async (t) => {
  const f = await fixture(t, { empty: true });
  for (let i = 0; i < 40; i++)
    f.work("work-" + String(i).padStart(3, "0"), {
      id: String(i),
      title: "Synthetic",
      date: `2030-02-${String((i % 20) + 1).padStart(2, "0")}T00:00:00Z`,
      user: { id: "100", name: "Synthetic author" },
    });
  const result = await buildCatalog({
    catalogPath: path.join(f.config.tempRoot, "parallel.sqlite"),
    platformRoots: f.bindings,
    batchSize: 10,
    maxPreparationWorkers: 3,
    concurrency: { disks: [] },
  });
  assert.equal(result.report.catalogCounts.works, 40);
  assert.ok(result.report.execution.preparation.peakPendingWorks > 1);
  assert.ok(result.report.execution.preparation.peakPendingWorks <= 3);
  assert.ok(result.report.execution.writer.peakPendingCandidates <= 10);
});

for (const mode of ["full", "incremental"]) {
  test(`${mode} author finalization waits for work from another platform in the shared pool`, async (t) => {
    const f = await fixture(t, { empty: true });
    f.work("synthetic-a", {
      id: "1",
      user: { id: "100", name: "Synthetic author" },
    });
    f.work("synthetic-b", undefined, undefined, "200", "pixivFANBOX");
    const baseCatalogPath = path.join(f.config.tempRoot, "baseline.sqlite");
    if (mode === "incremental") {
      await buildCatalog({
        catalogPath: baseCatalogPath,
        platformRoots: f.bindings,
        concurrency: { disks: [] },
      });
    }

    // Real observations from tiny temporary trees; explicitly interleave the
    // streams as separate production disks can. A is consumed to make room for
    // B, then A ends while B still occupies the sole preparation worker.
    const events = [];
    for await (const event of createObservationProducer({
      platformRoots: f.bindings,
      scopes: Object.keys(f.bindings).map((platformId) => ({ platformId })),
      concurrency: { disks: [] },
    }))
      events.push(event);
    const a = events.filter((event) => event.platformId === "pixiv");
    const b = events.filter((event) => event.platformId === "pixivFANBOX");
    const split = (group) => {
      const afterWork = group.findIndex((event) => event.type === "work") + 1;
      assert.ok(afterWork > 0);
      return [group.slice(0, afterWork), group.slice(afterWork)];
    };
    const [aStart, aEnd] = split(a),
      [bStart, bEnd] = split(b);
    const rest = events.filter(
      (event) => !["pixiv", "pixivFANBOX"].includes(event.platformId),
    );
    const interleaved = [...aStart, ...bStart, ...aEnd, ...bEnd, ...rest];
    const pool = createPreparationPool({ maxWorkers: 1 });
    t.after(() => pool.close());
    const finalizationCapacity = [];
    const preparationPool = {
      ...pool,
      map(...args) {
        finalizationCapacity.push(pool.stats().inFlight);
        return pool.map(...args);
      },
    };
    const run = mode === "full" ? buildCatalog : updateCatalog;
    const result = await run({
      catalogPath: path.join(f.config.tempRoot, "interleaved.sqlite"),
      ...(mode === "incremental" ? { baseCatalogPath } : {}),
      platformRoots: f.bindings,
      preparationPool,
      createObservationProducer: async function* () {
        yield* interleaved;
      },
    });
    assert.equal(result.report.catalogCounts.works, 2);
    assert.deepEqual(finalizationCapacity, [0, 0]);
    assert.equal(pool.stats().inFlight, 0);
    assert.equal(result.report.execution.preparation.peakPendingWorks, 1);
    assert.equal(result.report.changes.worksObserved, 2);
    assert.equal(
      result.report.changes.worksReused,
      mode === "incremental" ? 2 : 0,
    );
  });
}
