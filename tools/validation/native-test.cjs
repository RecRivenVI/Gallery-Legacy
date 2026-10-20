"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  Database = require("better-sqlite3");
const { prepare, repo, testRoot } = require("./prepare.cjs"),
  { scan } = require("./scan-support.cjs");
const { verifyCatalogContract } = require(
  path.join(repo, "src/catalog/writer.js"),
);
function read(config, fn) {
  const db = new Database(
    path.join(config.instanceRoot, "live/catalog.sqlite"),
    { readonly: true },
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
test(
  "Native nine-platform traversal reuses parser/writer without Everything",
  { timeout: 120000 },
  async () => {
    const root = path.join(testRoot, "GalleryGoNative-Test-") + Date.now(),
      demo = await prepare(root, { listingSource: "filesystem" });
    assert.equal(demo.scan.everything, undefined);
    assert.equal(demo.config.everything, null);
    const first = await scan(demo.config);
    assert.equal(first.code, 0, JSON.stringify(first.last));
    assert.equal(first.last.state, "COMPLETE");
    assert.equal(first.last.progress.listingSource, "filesystem");
    assert.equal(first.last.counts.listingBytes, 0);
    assert.equal(first.last.counts.volumeProbes, 9);
    assert.equal(first.last.counts.batches, 9);
    assert.equal(first.last.counts.reusedMediaAttributes, 284);
    assert.equal(first.last.counts.nativeDirectoryReads, 169);
    assert.ok(
      first.last.counts.nativeSafetyChecks < 284,
      "media must not be individually restatted",
    );
    assert.equal(
      first.last.counts.listingRows,
      98,
      "only root/author membership persists",
    );
    assert.ok(
      first.last.counts.listingTransactions < 169,
      "work enumeration must not create tiny SQL transactions",
    );
    assert.ok(
      first.last.counts.peakPreparationWorkers >= 2 &&
        first.last.counts.peakPreparationWorkers <= 8,
      "global work concurrency remains bounded",
    );
    assert.ok(
      first.last.counts.writeTransactions <= first.last.counts.batches + 9,
      "author completion must join bounded work commits",
    );
    assert.ok(
      first.last.counts.writeStatementCacheHits > 0,
      "writer SQL statements must be reused across commits",
    );
    assert.equal(first.last.progress.platformResults.length, 9);
    assert.equal(demo.scan.batchSize, 128);
    let prepared = 0;
    for (const platform of first.last.progress.platformResults) {
      assert.equal(platform.status, "COMPLETE");
      assert.ok(platform.writeTimings.transactions > 0);
      for (const key of ["totalMs", "catalogMs", "searchMs", "commitMs"])
        assert.ok(platform.writeTimings[key] >= 0);
      for (const key of [
        "totalMs",
        "enumerationMs",
        "nativeVerifyMs",
        "metadataReadMs",
        "metadataParseMs",
        "mappingMs",
        "admissionWaitMs",
        "directoryOpenMs",
        "directoryReadMs",
        "directoryMapMs",
        "directoryVerifyMs",
      ])
        assert.ok(platform.prepareTimings[key] >= 0);
      prepared += platform.prepareTimings.works;
    }
    for (const key of [
      "directoryOpenMs",
      "directoryReadMs",
      "directoryMapMs",
      "directoryVerifyMs",
    ])
      assert.ok(
        first.last.counts[key] >= 0,
        "missing directory cost breakdown",
      );
    assert.equal(prepared, 71);
    assert.equal(
      first.last.progress.commitGroups.work.transactions,
      first.last.counts.batches,
    );
    read(demo.config, (db) => {
      assert.equal(db.prepare("SELECT count(*) n FROM works").get().n, 71);
      assert.equal(db.prepare("SELECT count(*) n FROM media").get().n, 284);
      assert.equal(db.prepare("SELECT count(*) n FROM authors").get().n, 18);
      for (const state of ["missing", "malformed", "non_object"])
        assert.equal(
          db
            .prepare("SELECT count(*) n FROM works WHERE metadata_state=?")
            .get(state).n,
          9,
        );
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
    });
    const oraclePath = path.join(root, "oracle.sqlite");
    await require(
      path.join(repo, "src/indexing/engine.js"),
    ).executeCatalogBuild({
      catalogPath: oraclePath,
      platformRoots: demo.config.sources,
      mode: "full",
      maxPreparationWorkers: 2,
    });
    const oracle = new Database(oraclePath, { readonly: true });
    try {
      read(demo.config, (db) => {
        const cols = [
          "platform_id",
          "relative_path_key",
          "source_work_id",
          "source_work_id_source",
          "published_at_ms",
          "updated_at_ms",
          "sort_at_ms",
          "sort_time_source",
          "title",
          "title_source",
          "language",
          "is_adult",
          "is_ai_generated",
          "is_paid",
          "is_restricted",
          "is_sensitive",
          "has_full",
          "is_advertisement",
          "image_count",
          "video_count",
          "media_count",
          "filesystem_state",
          "filesystem_files_state",
          "metadata_state",
          "enrichment_state",
          "adapter_version",
        ];
        const q =
          "SELECT " +
          cols.join(",") +
          " FROM works ORDER BY platform_id,relative_path_key";
        assert.deepEqual(db.prepare(q).all(), oracle.prepare(q).all());
        const aq =
          "SELECT a.platform_id,a.relative_path_key,source_author_id,source_author_id_source,display_name,display_name_source,handle,work_count,profile_state,latest_work_at_ms,w.relative_path_key AS latest_work_key FROM authors a LEFT JOIN works w ON w.work_id=a.latest_work_id ORDER BY a.platform_id,a.relative_path_key";
        assert.deepEqual(db.prepare(aq).all(), oracle.prepare(aq).all());
        const mq =
          "SELECT w.platform_id,w.relative_path_key,m.relative_path,m.filesystem_media_type,m.filesystem_size,m.filesystem_mtime_ns FROM media m JOIN works w USING(work_id) ORDER BY w.platform_id,w.relative_path_key,m.relative_path";
        db.defaultSafeIntegers(true);
        oracle.defaultSafeIntegers(true);
        assert.deepEqual(db.prepare(mq).all(), oracle.prepare(mq).all());
      });
    } finally {
      oracle.close();
    }
    const identities = read(demo.config, (db) =>
      db
        .prepare("SELECT work_id,relative_path FROM works ORDER BY work_id")
        .all(),
    );
    const repeat = await scan(demo.config);
    assert.equal(repeat.code, 0, JSON.stringify(repeat.last));
    assert.deepEqual(
      read(demo.config, (db) =>
        db
          .prepare("SELECT work_id,relative_path FROM works ORDER BY work_id")
          .all(),
      ),
      identities,
    );
    // All mutations below are to generated synthetic sources, never real roots.
    const priorPixivMedia = read(
      demo.config,
      (db) =>
        db
          .prepare(
            "SELECT sum(media_count) n FROM works WHERE platform_id='pixiv'",
          )
          .get().n,
    );
    const work = path.join(
        demo.config.sources.pixiv,
        "700",
        "2026-01-01_00-00-00_duplicate",
      ),
      outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(work, "linked"), "junction");
    fs.unlinkSync(path.join(work, "10.png"));
    const incomplete = await scan(demo.config);
    assert.equal(incomplete.code, 1);
    assert.equal(
      read(
        demo.config,
        (db) =>
          db
            .prepare(
              "SELECT sum(media_count) n FROM works WHERE platform_id='pixiv'",
            )
            .get().n,
      ),
      priorPixivMedia,
      "incomplete platform changed committed media",
    );
    fs.unlinkSync(path.join(work, "linked"));
    const removed = await scan(demo.config);
    assert.equal(removed.code, 0, JSON.stringify(removed.last));
    assert.equal(
      read(
        demo.config,
        (db) => db.prepare("SELECT count(*) n FROM media").get().n,
      ),
      283,
    );
    const cancel = await scan(demo.config, { delay: 150, cancelAt: 1 });
    assert.equal(cancel.code, 1);
    assert.equal(cancel.last.state, "CANCELLED");
    read(demo.config, (db) => {
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
    });
    let killed = false;
    const crash = await scan(demo.config, {
      delay: 100,
      onProgress: (s, child) => {
        if (s.counts.worksCommitted && !killed) {
          killed = true;
          child.kill();
        }
      },
    });
    assert.ok(killed);
    assert.notEqual(crash.code, 0);
    const recovery = await scan(demo.config);
    assert.equal(recovery.code, 0, JSON.stringify(recovery.last));
    console.log(
      JSON.stringify({
        synthetic: true,
        listingSource: "filesystem",
        platforms: 9,
        works: 71,
        initialMedia: 284,
        directories: first.last.counts.nativeDirectoryReads,
        mediaAttributesReused: 284,
        everythingBytes: 0,
        oracleParity: true,
        repeatIdentity: true,
        incompleteProtection: true,
        cancellation: true,
        crashRecovery: true,
      }),
    );
  },
);
test(
  "Native bounded directory batches and indexed deletion reconcile complete scopes",
  { timeout: 120000 },
  async () => {
    const root = path.join(testRoot, "GalleryGoNative-Bulk-") + Date.now(),
      demo = await prepare(root, { listingSource: "filesystem" }),
      source = demo.config.sources.pixiv;
    const work = (i) => path.join(source, "synthetic bulk", String(i)),
      empty = (i) => path.join(source, "empty-" + i);
    for (let i = 0; i < 270; i++) {
      fs.mkdirSync(work(i), { recursive: true });
      fs.writeFileSync(path.join(work(i), "1.png"), "synthetic");
      fs.mkdirSync(empty(i));
    }
    const deep = path.join(work(0), "合成 空格", "nested");
    fs.mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 600; i++)
      fs.writeFileSync(path.join(deep, `${i}.png`), "synthetic");
    fs.writeFileSync(path.join(deep, "not-media.zip"), "not media");
    const first = await scan(demo.config);
    assert.equal(first.code, 0, JSON.stringify(first.last));
    assert.equal(first.last.counts.reusedMediaAttributes, 1154);
    assert.equal(
      read(
        demo.config,
        (db) => db.prepare("SELECT count(*) n FROM works").get().n,
      ),
      341,
    );
    const before = read(demo.config, (db) =>
      db
        .prepare("SELECT work_id,relative_path_key FROM works ORDER BY work_id")
        .all(),
    );
    const removed = new Set();
    for (let i = 1; i < 270; i++) {
      removed.add(path.relative(source, work(i)).toLowerCase());
      fs.rmSync(work(i), { recursive: true });
      fs.rmdirSync(empty(i));
    }
    const second = await scan(demo.config);
    assert.equal(second.code, 0, JSON.stringify(second.last));
    assert.equal(second.last.counts.worksDeleted, 269);
    read(demo.config, (db) => {
      assert.deepEqual(
        db
          .prepare(
            "SELECT work_id,relative_path_key FROM works ORDER BY work_id",
          )
          .all(),
        before.filter((w) => !removed.has(w.relative_path_key)),
      );
      assert.equal(db.prepare("SELECT count(*) n FROM authors").get().n, 20);
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
    });
    console.log(
      JSON.stringify({
        synthetic: true,
        listingSource: "filesystem",
        initialWorks: 341,
        initialMedia: 1154,
        deletedWorks: 269,
        deletedEmptyAuthors: 269,
        deepUnicode: true,
        readDirBatchBoundary: true,
      }),
    );
  },
);

test(
  "Explicit preparation budgets preserve nine-platform facts and FULL commits",
  { timeout: 120000 },
  async () => {
    let expected;
    for (const [workers, slowDeviceWorkers] of [
      [4, 2],
      [8, 4],
      [16, 8],
    ]) {
      const demo = await prepare(
        path.join(testRoot, "GalleryGoBudget-Test-") +
          Date.now() +
          "-" +
          workers,
        { listingSource: "filesystem" },
      );
      demo.scan.workers = workers;
      demo.scan.slowDeviceWorkers = slowDeviceWorkers;
      fs.writeFileSync(
        path.join(demo.config.instanceRoot, "go-scan.json"),
        JSON.stringify(demo.scan),
      );
      const result = await scan(demo.config);
      assert.equal(result.code, 0, JSON.stringify(result.last));
      assert.equal(result.last.state, "COMPLETE");
      assert.equal(result.last.counts.failures, 0);
      assert.ok(result.last.counts.peakPreparationWorkers <= workers);
      assert.equal(result.last.progress.platformResults.length, 9);
      const facts = read(demo.config, (db) => {
        db.defaultSafeIntegers(true);
        verifyCatalogContract(db, { allowLive: true });
        return {
          works: db
            .prepare(
              "SELECT platform_id,relative_path_key,source_work_id,title,metadata_state,media_count FROM works ORDER BY platform_id,relative_path_key",
            )
            .all(),
          media: db
            .prepare(
              "SELECT w.platform_id,w.relative_path_key,m.relative_path,m.filesystem_media_type,m.filesystem_size FROM media m JOIN works w USING(work_id) ORDER BY w.platform_id,w.relative_path_key,m.relative_path",
            )
            .all(),
          authors: db
            .prepare(
              "SELECT platform_id,relative_path_key,source_author_id,display_name,work_count FROM authors ORDER BY platform_id,relative_path_key",
            )
            .all(),
        };
      });
      assert.equal(facts.works.length, 71);
      assert.equal(facts.media.length, 284);
      if (expected) assert.deepEqual(facts, expected);
      else expected = facts;
    }
    console.log(
      JSON.stringify({
        synthetic: true,
        preparationBudgets: [4, 8, 16],
        slowDeviceBudgets: [2, 4, 8],
        factsEqual: true,
        platforms: 9,
        works: 71,
        media: 284,
      }),
    );
  },
);
