"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const { buildCatalog } = require("../../internal/indexing/build.js");
const { fullScan } = require("../../internal/indexing/task.js");
test("streaming batch sizes retain identical physical entities, counts and fallback", async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  for (const batchSize of [1, 2, 500]) {
    const file = path.join(f.config.tempRoot, `batch-${batchSize}.sqlite`);
    const { report } = buildCatalog({
      catalogPath: file,
      platformRoots: f.bindings,
      batchSize,
    });
    assert.equal(report.state, "READY");
    assert.equal(report.global.worksIndexed, 6);
    assert.equal(report.global.actualMedia, 7);
    const db = new Database(file, { readonly: true });
    try {
      snapshots.push(
        db
          .prepare(
            "SELECT relative_path_key,title,metadata_state,image_count,video_count,media_count FROM works ORDER BY relative_path_key",
          )
          .all(),
      );
    } finally {
      db.close();
    }
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[1], snapshots[2]);
  assert.throws(
    () =>
      buildCatalog({
        catalogPath: path.join(f.bindings.pixiv, "unsafe.sqlite"),
        platformRoots: f.bindings,
      }),
    { code: "SOURCE_PATH_OVERLAP" },
  );
  assert.equal(
    fs.existsSync(path.join(f.bindings.pixiv, "unsafe.sqlite")),
    false,
  );
});
test("the same full-scan use case produces aggregate telemetry and publication under a write guard", async (t) => {
  const f = await fixture(t);
  await assert.rejects(fullScan(f.config), {
    code: "READ_ONLY_CONFIRMATION_REQUIRED",
  });
  const report = await fullScan(f.config, {
    confirmReadOnly: true,
    generationId: "test-scan",
  });
  assert.equal(report.state, "READY");
  assert.equal(report.sourceWriteAttempts, 0);
  const status = JSON.parse(fs.readFileSync(f.config.scanStatusPath));
  assert.equal(status.state, "READY");
  assert.equal(status.running, false);
  assert.equal(status.platforms.length, 8);
  assert.equal(status.indexedWorks, 6);
  assert.equal(status.actualMedia, 7);
  assert.ok(status.peakMemory.rss > 0);
  assert.ok(status.startedAtMs > 0);
  assert.equal(status.startedAt, undefined);
  assert.equal(
    fs.existsSync(path.join(f.config.stateRoot, "scan.lock")),
    false,
  );
  const text = fs.readFileSync(
    path.join(f.config.reportsRoot, "test-scan.json"),
    "utf8",
  );
  assert.equal(text.includes("Sample author"), false);
  assert.equal(text.includes(f.bindings.pixiv), false);
});
