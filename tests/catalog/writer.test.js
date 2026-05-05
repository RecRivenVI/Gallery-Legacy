"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const {
  initializeCatalog,
  applyMappedBatch,
} = require("../../internal/catalog/writer.js");
const {
  observePlatformTree,
} = require("../../internal/library/observation.js");
const {
  preparePlatformSnapshot,
} = require("../../internal/indexing/preparation.js");
const { validateCatalog } = require("../../internal/catalog/validation.js");
test("Writer is idempotent by physical identity; bad batches roll back without losing collisions", async (t) => {
  const f = await fixture(t);
  const prepared = preparePlatformSnapshot(
    observePlatformTree({
      platformId: "pixiv",
      observationRoot: f.bindings.pixiv,
    }),
  );
  const db = new Database(":memory:");
  try {
    initializeCatalog(db, { builtAtMs: 1, platformRoots: f.bindings });
    applyMappedBatch(db, prepared.preparedCandidates, { observedAtMs: 1 });
    const first = validateCatalog(db);
    applyMappedBatch(db, prepared.preparedCandidates, { observedAtMs: 2 });
    assert.deepEqual(validateCatalog(db), first);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM works WHERE source_work_id='same'")
        .get().n,
      2n,
    );
    const changed = structuredClone(prepared.preparedCandidates);
    changed.at(-1).rows.work.relative_path_key = "../escape";
    assert.throws(() => applyMappedBatch(db, changed, { observedAtMs: 3 }));
    assert.deepEqual(validateCatalog(db), first);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM works WHERE platform_id=? AND relative_path_key=?",
      )
      .all("pixiv", "a/b");
    assert.ok(plan.some((p) => /USING.*INDEX/.test(p.detail)));
    const mediaPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM media WHERE work_id=? ORDER BY relative_path_key",
      )
      .all(1n);
    assert.ok(mediaPlan.some((p) => /USING.*INDEX/.test(p.detail)));
  } finally {
    db.close();
  }
});
