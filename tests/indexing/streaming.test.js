"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const { buildCatalog } = require("../../internal/indexing/build.js");
const { fullScan } = require("../../internal/indexing/task.js");
const { acquireOwnership } = require("../../internal/instance/ownership.js");
test("streaming batch sizes retain identical physical entities, counts and fallback", async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  for (const batchSize of [1, 2, 500]) {
    const file = path.join(f.config.tempRoot, `batch-${batchSize}.sqlite`);
    const { report } = await buildCatalog({
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
  await assert.rejects(
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
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  await assert.rejects(fullScan(f.config), {
    code: "READ_ONLY_CONFIRMATION_REQUIRED",
  });
  const running = fullScan(f.config, {
    confirmReadOnly: true,
    generationId: "test-scan",
  });
  let terminal = null;
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (fs.existsSync(f.config.scanStatusPath)) {
      terminal = JSON.parse(fs.readFileSync(f.config.scanStatusPath, "utf8"));
      if (terminal.state === "READY" && terminal.running === false) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(terminal?.state, "READY");
  const immediateLease = await acquireOwnership(f.config, "scan");
  await immediateLease.release();
  const report = await running;
  assert.equal(report.state, "READY");
  assert.equal(report.sourceWriteAttempts, 0);
  const status = JSON.parse(fs.readFileSync(f.config.scanStatusPath));
  assert.equal(status.state, "READY");
  assert.equal(status.running, false);
  assert.equal(status.platforms.length, 9);
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
