"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { NODE_FS_IO } = require("../../internal/library/observer.js");
const {
  resolveActiveGeneration,
  publishGeneration,
  finalizeSqliteFile,
  validateGeneration,
} = require("../../internal/publication/generations.js");
const { hashDatabaseFile } = require("../../internal/catalog/file-hash.js");
test("READY publication, atomic failure, rollback and immutability", async (t) => {
  const f = await fixture(t);
  const first = f.build();
  f.publish();
  const second = f.build("second");
  const before = fs.readFileSync(f.config.activeGenerationPath);
  assert.throws(() =>
    publishGeneration(f.config.instanceRoot, "second", {
      atomicWriteHooks: {
        rename() {
          throw new Error("synthetic failure");
        },
      },
    }),
  );
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath), before);
  f.publish("second");
  assert.equal(
    resolveActiveGeneration(f.config.instanceRoot).generationId,
    "second",
  );
  f.publish("first");
  assert.equal(
    resolveActiveGeneration(f.config.instanceRoot).generationId,
    "first",
  );
  assert.throws(() => finalizeSqliteFile(first.catalogPath), {
    code: "GENERATION_IMMUTABLE",
  });
  for (const g of [first, second]) {
    assert.equal(hashDatabaseFile(g.catalogPath), g.catalogFacts.sha256);
    for (const base of [g.catalogPath, g.searchIndexPath])
      for (const suffix of ["-wal", "-shm", "-journal"])
        assert.equal(fs.existsSync(base + suffix), false);
  }
  fs.writeFileSync(f.config.activeGenerationPath, "{");
  assert.throws(() => resolveActiveGeneration(f.config.instanceRoot));
});
test("nested filesystem failure cannot publish and leaves prior active generation intact", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const before = fs.readFileSync(f.config.activeGenerationPath);
  const io = {
    ...NODE_FS_IO,
    readdir(file, ...args) {
      if (path.basename(file) === "nested")
        throw Object.assign(new Error("synthetic unreadable"), {
          code: "EACCES",
        });
      return NODE_FS_IO.readdir(file, ...args);
    },
  };
  assert.throws(() => f.build("incomplete", { io }), {
    code: "GENERATION_CATALOG_INCOMPLETE",
  });
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath), before);
  const root = path.join(f.config.generationsRoot, "incomplete");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))).state,
    "BUILDING",
  );
  assert.throws(() =>
    validateGeneration(root, { instanceRoot: f.config.instanceRoot }),
  );
});
