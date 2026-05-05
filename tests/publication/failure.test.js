"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const {
  buildGeneration,
  finalizeSqliteFile,
  publishGeneration,
  resolveActiveGeneration,
} = require("../../internal/publication/generations.js");
test("committed WAL is checkpointed to the immutable final file before hashing", async (t) => {
  const f = await fixture(t, { empty: true }),
    file = path.join(f.config.tempRoot, "wal.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode=WAL");
  db.exec(
    "CREATE TABLE sample(v TEXT); INSERT INTO sample VALUES('synthetic')",
  );
  assert.ok(fs.statSync(file + "-wal").size > 0);
  db.close();
  assert.equal(finalizeSqliteFile(file).journalMode, "delete");
  const read = new Database(file, { readonly: true });
  try {
    assert.equal(read.prepare("SELECT v FROM sample").get().v, "synthetic");
  } finally {
    read.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    assert.equal(fs.existsSync(file + suffix), false);
});
test("failure during finalization or non-ready manifest cannot disturb the old pointer", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const before = fs.readFileSync(f.config.activeGenerationPath);
  assert.throws(
    () =>
      buildGeneration({
        instanceRoot: f.config.instanceRoot,
        generationId: "failed-finalize",
        catalogOptions: { platformRoots: f.bindings },
        finalizeGeneration() {
          throw Object.assign(new Error("synthetic failure"), {
            code: "FINALIZE_FAILED",
          });
        },
      }),
    { code: "FINALIZE_FAILED" },
  );
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath), before);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(f.config.generationsRoot, "failed-finalize/manifest.json"),
      ),
    ).state,
    "BUILDING",
  );
  assert.throws(() =>
    publishGeneration(f.config.instanceRoot, "failed-finalize"),
  );
  assert.equal(
    resolveActiveGeneration(f.config.instanceRoot).generationId,
    "first",
  );
});
test("Catalog/Search cross-generation mismatch is rejected and running generations are not hot swapped", async (t) => {
  const f = await fixture(t),
    a = f.build();
  f.publish();
  f.work("new-physical-work", {});
  const b = f.build("second");
  const copy = path.join(f.config.generationsRoot, "mismatched");
  fs.cpSync(b.generationRoot, copy, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(copy, "manifest.json")),
  );
  manifest.generationId = "mismatched";
  fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(manifest));
  fs.copyFileSync(
    a.searchIndexPath,
    path.join(copy, "search/gallery-search.sqlite"),
  );
  assert.throws(() => publishGeneration(f.config.instanceRoot, "mismatched"));
  assert.equal(
    resolveActiveGeneration(f.config.instanceRoot).generationId,
    "first",
  );
  const {
    createRuntimeBootstrap,
  } = require("../../internal/runtime/bootstrap.js");
  const r = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => r.close());
  await r.start();
  f.publish("second");
  assert.equal(r.status().loadedGenerationId, "first");
  assert.equal(r.status().activeGenerationId, "second");
  assert.equal(r.status().restartRequired, true);
  assert.equal(
    (await (await fetch(f.config.url + "/api/v1/works")).json()).data.total,
    6,
  );
  await r.close();
  const next = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => next.close());
  await next.start();
  assert.equal(next.status().loadedGenerationId, "second");
});
