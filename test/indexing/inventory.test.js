"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  Database = require("better-sqlite3");
const { fixture } = require("../support/runtime.js");
const { everythingServer, inventory } = require("../support/everything.js");
const { normalizeRuntimeConfig } = require("../../src/instance/config.js");
const { fullScan } = require("../../src/indexing/task.js");
const {
  resolveActiveGeneration,
} = require("../../src/publication/generations.js");
const { hashDatabaseFile } = require("../../src/catalog/file-hash.js");
const { createInventorySession } = require("../../src/indexing/inventory.js");
function current(f) {
  return resolveActiveGeneration(f.config.instanceRoot);
}
function generation(f) {
  const db = new Database(
    path.join(f.config.stateRoot, "indexing", "inventory.sqlite"),
    { readonly: true },
  );
  try {
    return db.prepare("SELECT value FROM meta WHERE key='generation'").get()
      ?.value;
  } finally {
    db.close();
  }
}
async function setup(t, options = {}) {
  const f = await fixture(t, options),
    server = await everythingServer(t, f.bindings);
  f.config = normalizeRuntimeConfig({
    instanceRoot: f.config.instanceRoot,
    sources: f.bindings,
    port: f.config.port,
    everything: { endpoint: server.endpoint },
  });
  // Node's lazy rimraf loader must bind the original filesystem functions before
  // a scan installs the source-write guard (same setup as other indexing tests).
  const prewarm = path.join(f.config.tempRoot, "inventory-cleanup-prewarm");
  fs.mkdirSync(prewarm);
  fs.rmSync(prewarm, { recursive: true });
  return { f, server };
}
const scan = (f, id, options = {}) =>
  fullScan(f.config, { confirmReadOnly: true, generationId: id, ...options });

test("qualified unchanged inventory skips all metadata reads and file stats, preserving Catalog v4 and READY", async (t) => {
  const { f, server } = await setup(t);
  const first = await scan(f, "inventory-base");
  assert.ok(first.inventory.nativeDirectoryReads > 0);
  const hash = hashDatabaseFile(current(f).catalogPath);
  const baselineDb = new Database(current(f).catalogPath, { readonly: true });
  const snapshot = baselineDb
    .prepare(
      "SELECT relative_path_key,source_work_id,title,metadata_state,media_count FROM works ORDER BY relative_path_key",
    )
    .all();
  baselineDb.close();
  const report = await scan(f, "inventory-reused", { mode: "incremental" });
  assert.equal(
    report.inventory.metadataReads,
    0,
    JSON.stringify({ inventory: report.inventory, changes: report.changes }),
  );
  assert.equal(report.changes.metadataRead, 0);
  assert.equal(report.changes.worksRebuilt, 0);
  assert.equal(report.changes.worksReused, 6);
  assert.equal(report.inventory.nativeDirectoryReads, 0);
  assert.ok(report.inventory.indexedStats > 0);
  assert.ok(report.inventory.nativeStats < first.inventory.nativeStats);
  assert.equal(generation(f), "inventory-reused");
  assert.equal(
    hashDatabaseFile(
      path.join(
        f.config.generationsRoot,
        "inventory-base",
        "catalog",
        "gallery-v4.sqlite",
      ),
    ),
    hash,
  );
  assert.equal(server.controls.requests.length, 18);
  const db = new Database(current(f).catalogPath, { readonly: true });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT relative_path_key,source_work_id,title,metadata_state,media_count FROM works ORDER BY relative_path_key",
        )
        .all(),
      snapshot,
    );
  } finally {
    db.close();
  }
});

test("malformed inventory paths, duplicates, properties and ancestors are rejected before observation", async (t) => {
  const { f, server } = await setup(t);
  for (const [mutate, code] of [
    [
      (rows) => {
        rows[0].name = "../escape";
      },
      "EVERYTHING_ROW_INVALID",
    ],
    [
      (rows) => {
        rows[0].path = path.dirname(f.bindings.pixiv);
      },
      "EVERYTHING_SCOPE_ESCAPE",
    ],
    [
      (rows) => {
        rows[1] = { ...rows[0] };
      },
      "EVERYTHING_DUPLICATE_PATH",
    ],
    [
      (rows) => {
        delete rows[0].date_modified;
      },
      "EVERYTHING_PROPERTIES_MISSING",
    ],
    [
      (rows) => {
        rows[0].date_modified = "9".repeat(24);
      },
      "EVERYTHING_TIME_INVALID",
    ],
    [
      (rows) => {
        rows[0].path = path.join(f.bindings.pixiv, "unindexed-parent");
      },
      "EVERYTHING_INVENTORY_INCOMPLETE",
    ],
  ]) {
    server.controls.transform = (rows) => {
      mutate(rows);
      return rows;
    };
    const session = createInventorySession({
      config: f.config,
      baselineGenerationId: null,
      mode: "full",
    });
    try {
      await assert.rejects(
        session.createObservationProducer({
          platformRoots: f.bindings,
          scopes: [{ platformId: "pixiv" }],
        }),
        { code },
      );
    } finally {
      session.close();
    }
  }
  assert.equal(fs.existsSync(f.config.activeGenerationPath), false);
  assert.equal(generation(f), undefined);
});

test("cancellation and unavailable Everything leave the published inventory baseline untouched", async (t) => {
  const { f, server } = await setup(t);
  await scan(f, "cancel-base");
  server.controls.status = 503;
  await assert.rejects(scan(f, "unavailable", { mode: "incremental" }), {
    code: "EVERYTHING_HTTP_FAILED",
  });
  server.controls.status = 200;
  server.controls.delay = 500;
  const timer = setTimeout(
    () =>
      fs.writeFileSync(
        path.join(f.config.stateRoot, "scan-cancel.json"),
        JSON.stringify({
          generationId: "cancel-index",
          requestedAtMs: Date.now(),
        }),
      ),
    100,
  );
  try {
    await assert.rejects(scan(f, "cancel-index", { mode: "incremental" }), {
      code: "SCAN_CANCELLED",
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(current(f).generationId, "cancel-base");
  assert.equal(generation(f), "cancel-base");
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(f.config.reportsRoot, "cancel-index.json"),
        "utf8",
      ),
    ).sourceWriteAttempts,
    0,
  );
});

test("nested changes with unchanged work/author mtime and backdated additions are discovered", async (t) => {
  const { f } = await setup(t, { empty: true });
  const dir = f.work(
    "2026-01-01_00-00-00_1",
    { id: "same", title: "Synthetic", user: { id: "1", name: "Profile" } },
    { "chapter/1.png": f.PNG },
  );
  await scan(f, "nested-base");
  const authorTime = fs.statSync(path.dirname(dir), { bigint: true }).mtimeNs,
    workTime = fs.statSync(dir, { bigint: true }).mtimeNs;
  const added = path.join(dir, "chapter", "2.png");
  fs.writeFileSync(added, f.PNG);
  fs.utimesSync(added, new Date("2017-01-01"), new Date("2017-01-01"));
  assert.equal(
    fs.statSync(path.dirname(dir), { bigint: true }).mtimeNs,
    authorTime,
  );
  assert.equal(fs.statSync(dir, { bigint: true }).mtimeNs, workTime);
  const report = await scan(f, "nested-changed", { mode: "incremental" });
  assert.equal(report.build.counts.media, 2);
  assert.equal(report.changes.worksUpdated, 1);
  assert.ok(report.inventory.added >= 1);
});

test("metadata update without parent mtime change updates work and authoritative author", async (t) => {
  const { f } = await setup(t, { empty: true });
  const dir = f.work("2026-01-01_00-00-00_1", {
    id: "1",
    title: "Before",
    user: { id: "1", name: "Before author" },
  });
  await scan(f, "metadata-base");
  const time = fs.statSync(dir, { bigint: true }).mtimeNs;
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      id: "1",
      title: "Changed longer",
      user: { id: "1", name: "Changed author" },
    }),
  );
  assert.equal(fs.statSync(dir, { bigint: true }).mtimeNs, time);
  await scan(f, "metadata-changed", { mode: "incremental" });
  const db = new Database(current(f).catalogPath, { readonly: true });
  try {
    assert.equal(
      db.prepare("SELECT title FROM works").get().title,
      "Changed longer",
    );
    assert.equal(
      db.prepare("SELECT display_name FROM authors").get().display_name,
      "Changed author",
    );
  } finally {
    db.close();
  }
});

test("missing indexed existing files, truncated response and stale timestamps never advance pointer or inventory", async (t) => {
  const { f, server } = await setup(t);
  await scan(f, "failure-base");
  server.controls.transform = (rows) => rows.filter((r) => r.name !== "1.png");
  await assert.rejects(scan(f, "missing-indexed", { mode: "incremental" }), {
    code: "EVERYTHING_INVENTORY_INCOMPLETE",
  });
  server.controls.transform = null;
  server.controls.truncate = true;
  await assert.rejects(
    scan(f, "truncated", { mode: "incremental" }),
    /EVERYTHING_/,
  );
  server.controls.truncate = false;
  server.controls.snapshot = Object.fromEntries(
    Object.values(f.bindings).map((root) => [root, inventory(root)]),
  );
  f.work("2028-01-01_00-00-00_1", undefined);
  await assert.rejects(
    scan(f, "stale-index", { mode: "incremental" }),
    /EVERYTHING_/,
  );
  assert.equal(current(f).generationId, "failure-base");
  assert.equal(generation(f), "failure-base");
});

test("constant-count omitted existing entry fails native absence verification", async (t) => {
  const { f, server } = await setup(t);
  await scan(f, "omission-base");
  server.controls.transform = (rows) => {
    const row = rows.find((r) => r.name === "1.png");
    row.name = "phantom.png";
    return rows;
  };
  await assert.rejects(scan(f, "omission", { mode: "incremental" }), {
    code: "EVERYTHING_MISSING_EXISTING_PATH",
  });
  assert.equal(current(f).generationId, "omission-base");
});

test("confirmed deletions preserve other scopes, and scoped updates do not consume unvisited changes", async (t) => {
  const { f } = await setup(t, { empty: true });
  const first = f.work(
    "2026-01-01_00-00-00_1",
    { id: "a", title: "A" },
    undefined,
    "author-a",
  );
  const second = f.work(
    "2026-01-01_00-00-00_2",
    { id: "b", title: "B" },
    undefined,
    "author-b",
  );
  await scan(f, "scoped-base");
  fs.writeFileSync(path.join(first, "2.png"), f.PNG);
  fs.writeFileSync(path.join(second, "2.png"), f.PNG);
  await scan(f, "scoped-a", {
    mode: "incremental",
    platformId: "pixiv",
    authorDirectoryName: "author-a",
  });
  const updated = await scan(f, "scoped-b", {
    mode: "incremental",
    platformId: "pixiv",
    authorDirectoryName: "author-b",
  });
  assert.equal(updated.build.counts.media, 4);
  fs.unlinkSync(path.join(first, "2.png"));
  const deleted = await scan(f, "deleted", { mode: "incremental" });
  assert.equal(deleted.build.counts.media, 3);
  assert.ok(deleted.inventory.removed >= 1);
});

test("a reparse entry in a candidate prevents READY and leaves the previous checkpoint intact", async (t) => {
  const { f } = await setup(t, { empty: true });
  const dir = f.work("2026-01-01_00-00-00_1", undefined);
  await scan(f, "link-base");
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "outside.png"), f.PNG);
  fs.symlinkSync(outside, path.join(dir, "linked"), "junction");
  await assert.rejects(
    scan(f, "link-blocked", { mode: "incremental" }),
    /EVERYTHING_/,
  );
  assert.equal(current(f).generationId, "link-base");
  assert.equal(generation(f), "link-base");
});

test("a failed direct live update keeps confirmed work and its ledger without publishing a candidate", async (t) => {
  const { f } = await setup(t);
  const { openLive } = require("../../src/catalog/live.js");
  f.config = normalizeRuntimeConfig({
    instanceRoot: f.config.instanceRoot,
    sources: f.bindings,
    port: f.config.port,
    everything: f.config.everything,
    liveUpdates: true,
  });
  await scan(f, "live-inventory-base");
  f.work("2029-02-01_00-00-00_new", {
    id: "synthetic-new",
    title: "New complete work",
  });
  await assert.rejects(
    scan(f, "live-inventory-failed", {
      mode: "incremental",
      batchSize: 1,
      onCommittedBatch({ mappedCandidates }) {
        if (
          mappedCandidates.some(
            (c) => c.rows.work.title === "New complete work",
          )
        )
          throw Object.assign(
            new Error("synthetic coordinator failure after commit"),
            { code: "SYNTHETIC_FAILURE" },
          );
      },
    }),
    { code: "SYNTHETIC_FAILURE" },
  );
  assert.equal(fs.existsSync(f.config.activeGenerationPath), false);
  const live = openLive(f.config, null, { readonly: true });
  try {
    assert.equal(
      live.db
        .prepare("SELECT count(*) n FROM works WHERE title='New complete work'")
        .get().n,
      1n,
    );
  } finally {
    live.close();
  }
  const next = await scan(f, "live-inventory-recovered", {
    mode: "incremental",
  });
  assert.equal(next.state, "READY");
  assert.equal(next.build.counts.works, 7);
  assert.equal(fs.existsSync(f.config.activeGenerationPath), false);
  assert.equal(next.searchRebuilt, false);
});

test("baseline mismatch and forced observation never trust cached file stats", async (t) => {
  const { f } = await setup(t);
  const options = {
    platformRoots: f.bindings,
    scopes: [{ platformId: "pixiv" }],
    concurrency: { disks: [], unknownIo: 1 },
  };
  async function observe(
    baselineGenerationId,
    mode,
    extra = {},
    commit = null,
  ) {
    const session = createInventorySession({
      config: f.config,
      baselineGenerationId,
      mode,
    });
    try {
      const events = await session.createObservationProducer({
        ...options,
        ...extra,
      });
      for await (const event of events) {
        assert.notEqual(event.observation?.authorsState, "incomplete");
      }
      const stats = session.stats();
      if (commit) session.commit(commit);
      return stats;
    } finally {
      session.close();
    }
  }
  await observe(null, "full", {}, "qualified");
  const mismatch = await observe("rollback-choice", "incremental");
  assert.equal(mismatch.baselineMatched, false);
  assert.equal(mismatch.indexedStats, 0);
  assert.ok(mismatch.nativeDirectoryReads > 0);
  const forced = await observe("qualified", "incremental", {
    scopes: [{ platformId: "pixiv", forceFullObservation: true }],
  });
  assert.equal(forced.baselineMatched, true);
  assert.equal(forced.indexedStats, 0);
  assert.ok(forced.nativeDirectoryReads > 0);
  assert.equal(generation(f), "qualified");
});

test("directory timestamp drift uses physical facts and rechecks contents without rejecting a complete scope", async (t) => {
  const { f, server } = await setup(t, { empty: true });
  const dir = f.work("2026-01-01_00-00-00_1", {
    id: "synthetic",
    title: "Synthetic",
  });
  const timestamp = fs.lstatSync(dir, { bigint: true }).mtimeNs.toString();
  server.controls.transform = (rows) =>
    rows.map((row) =>
      row.type === "folder"
        ? {
            ...row,
            date_modified: (BigInt(row.date_modified) + 10043n).toString(),
          }
        : row,
    );
  const first = await scan(f, "directory-time-base");
  assert.equal(first.state, "READY");
  assert.equal(first.build.counts.works, 1);
  assert.equal(first.build.counts.media, 1);
  assert.ok(first.inventory.directoryMtimeRefreshes >= 2);
  const hash = hashDatabaseFile(current(f).catalogPath);
  const second = await scan(f, "directory-time-incremental", {
    mode: "incremental",
  });
  assert.equal(second.state, "READY");
  assert.ok(second.inventory.directoryMtimeRefreshes >= 2);
  assert.ok(second.inventory.nativeDirectoryReads >= 2);
  assert.equal(second.inventory.indexedStats, 0);
  assert.equal(second.build.counts.works, 1);
  assert.equal(second.build.counts.media, 1);
  assert.equal(second.sourceWriteAttempts, 0);
  const db = new Database(current(f).catalogPath, { readonly: true });
  db.defaultSafeIntegers(true);
  try {
    assert.equal(
      db
        .prepare("SELECT work_dir_mtime_ns FROM works")
        .get()
        .work_dir_mtime_ns.toString(),
      timestamp,
    );
  } finally {
    db.close();
  }
  assert.equal(
    hashDatabaseFile(
      path.join(
        f.config.generationsRoot,
        "directory-time-base",
        "catalog",
        "gallery-v4.sqlite",
      ),
    ),
    hash,
  );
});

test("directory time reconciliation cannot hide omitted entries or changed file attributes", async (t) => {
  const { f, server } = await setup(t, { empty: true });
  const dir = f.work(
    "2026-01-01_00-00-00_1",
    { id: "synthetic", title: "Synthetic" },
    { "1.png": f.PNG, "2.png": f.PNG },
  );
  await scan(f, "directory-mismatch-base");
  const hash = hashDatabaseFile(current(f).catalogPath);
  const shifted = (rows) =>
    rows.map((row) =>
      row.type === "folder"
        ? {
            ...row,
            date_modified: (BigInt(row.date_modified) + 5003n).toString(),
          }
        : row,
    );
  server.controls.transform = (rows) =>
    shifted(rows).map((row) =>
      row.name === "2.png" ? { ...row, name: "absent.png" } : row,
    );
  await assert.rejects(
    scan(f, "directory-membership-failed", { mode: "incremental" }),
    /EVERYTHING_/,
  );
  server.controls.transform = (rows) =>
    shifted(rows).map((row) =>
      row.name === "1.png"
        ? { ...row, date_modified: (BigInt(row.date_modified) + 1n).toString() }
        : row,
    );
  await assert.rejects(
    scan(f, "directory-file-time-failed", { mode: "incremental" }),
    { code: "EVERYTHING_INDEX_MISMATCH" },
  );
  server.controls.transform = (rows) =>
    shifted(rows).map((row) =>
      row.name === "1.png"
        ? { ...row, size: (BigInt(row.size) + 1n).toString() }
        : row,
    );
  await assert.rejects(
    scan(f, "directory-file-size-failed", { mode: "incremental" }),
    { code: "EVERYTHING_INDEX_MISMATCH" },
  );
  assert.equal(current(f).generationId, "directory-mismatch-base");
  assert.equal(generation(f), "directory-mismatch-base");
  assert.equal(hashDatabaseFile(current(f).catalogPath), hash);
  assert.ok(fs.existsSync(path.join(dir, "2.png")));
});
