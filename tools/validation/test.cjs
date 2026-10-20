"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { spawn } = require("node:child_process"),
  Database = require("better-sqlite3");
const { prepare, repo, testRoot } = require("./prepare.cjs");
const { openLive, getLiveState } = require(
  path.join(repo, "src/catalog/live.js"),
);
const { verifyCatalogContract } = require(
  path.join(repo, "src/catalog/writer.js"),
);
const { QueryIndex } = require(path.join(repo, "src/search/query.js"));
const EXE = process.env.GALLERY_GO_ACCEPTANCE_EXE;
const { scan } = require("./scan-support.cjs");
function dbRead(config, fn) {
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
  "Go nine-platform live scan and readonly API remain usable",
  { timeout: 120000 },
  async (t) => {
    assert.ok(EXE, "GALLERY_GO_ACCEPTANCE_EXE required");
    const root = path.join(testRoot, "GalleryGoAcceptance-Test-") + Date.now();
    const demo = await prepare(root);
    const { createRuntimeServer } = require(
      path.join(repo, "src/server/http.js"),
    );
    const config = {
      ...demo.config,
      port: 18259,
      url: "http://127.0.0.1:18259",
      publicUrl: "http://127.0.0.1:18259",
      allowedHosts: ["127.0.0.1:18259"],
      allowedOrigins: ["http://127.0.0.1:18259"],
    };
    let server = await createRuntimeServer({
      config,
      generation: null,
      status: () => ({ state: "READY", instanceId: config.instanceId }),
      onScan: () => {
        throw Error("NODE_SCANNER_FORBIDDEN");
      },
    });
    await server.start();
    t.after(() => server.close());
    let during = false,
      polls = 0,
      errors = 0,
      slow = 0,
      max = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const now = performance.now();
        try {
          const r = await fetch(config.url + "/api/v1/status", {
            signal: AbortSignal.timeout(3000),
          });
          if (r.status !== 200) errors++;
          const v = await r.json();
          polls++;
          max = Math.max(max, performance.now() - now);
          if (v.data.counts.works > 0) during = true;
        } catch {
          errors++;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    // Progress messages and independently opened DB snapshots are not one atomic
    // sample. Seal eligibility is tested at the spool boundary, not by comparing
    // a delayed stdout event to a newer database snapshot.
    const first = await scan(demo.config, { delay: 100 });
    polling = false;
    await poll;
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(first.last.state, "COMPLETE");
    assert.equal(errors, 0);
    assert.ok(polls > 3);
    assert.ok(during, "confirmed live commits visible while scan running");
    assert.equal(
      first.last.counts.volumeProbes,
      9,
      "disk classification must not run per work",
    );
    assert.equal(
      first.last.counts.batches,
      9,
      "small platform batches must not fragment at author boundaries",
    );
    assert.equal(first.last.progress.platformResults.length, 9);
    dbRead(demo.config, (db) => {
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
      assert.ok(getLiveState(db).revision > 1);
      db.defaultSafeIntegers(false);
      assert.equal(db.prepare("SELECT count(*) n FROM platforms").get().n, 9);
      assert.equal(db.prepare("SELECT count(*) n FROM media").get().n, 284);
      assert.equal(db.prepare("SELECT count(*) n FROM works").get().n, 71);
      assert.equal(db.prepare("SELECT count(*) n FROM authors").get().n, 18);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM works WHERE metadata_state='missing'",
          )
          .get().n,
        9,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM works WHERE metadata_state='malformed'",
          )
          .get().n,
        9,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM works WHERE metadata_state='non_object'",
          )
          .get().n,
        9,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM live_scan_works").get().n,
        71,
      );
    });
    // Differential fixture: compare all visible work scalar fields and media facts
    // against the current Node scanner on the same synthetic filesystem only.
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
      dbRead(demo.config, (db) => {
        const columns = [
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
          columns.join(",") +
          " FROM works ORDER BY platform_id,relative_path_key";
        const actual = db.prepare(q).all(),
          expected = oracle.prepare(q).all();
        const differences = [];
        actual.forEach((row, i) =>
          Object.entries(row).forEach(([key, value]) => {
            if (value !== expected[i][key])
              differences.push({
                platform: row.platform_id,
                work: row.relative_path_key,
                key,
                actual: value,
                expected: expected[i][key],
              });
          }),
        );
        assert.deepEqual(
          differences,
          [],
          "Node/Go visible work contract differences",
        );
        const authorColumns = [
          "a.platform_id",
          "a.relative_path_key",
          "source_author_id",
          "source_author_id_source",
          "display_name",
          "display_name_source",
          "handle",
          "work_count",
          "profile_state",
          "latest_work_at_ms",
          "w.relative_path_key AS latest_work_key",
        ];
        const aq =
          "SELECT " +
          authorColumns.join(",") +
          " FROM authors a LEFT JOIN works w ON w.work_id=a.latest_work_id ORDER BY a.platform_id,a.relative_path_key";
        assert.deepEqual(
          db.prepare(aq).all(),
          oracle.prepare(aq).all(),
          "Node/Go author authority contract",
        );
      });
    } finally {
      oracle.close();
    }
    const works = (
      await (
        await fetch(config.url + "/api/v1/works?platform=Venera&pageSize=10")
      ).json()
    ).data;
    assert.ok(works.items?.length > 0);
    const id = works.items[0].id;
    const detail = await (
      await fetch(config.url + "/api/v1/works/" + id)
    ).json();
    assert.equal(detail.data.media.length, 4);
    assert.deepEqual(
      detail.data.media.slice(0, 3).map((m) => path.basename(m.relativePath)),
      ["1.png", "2.png", "10.png"],
    );
    const get = async (route) => {
      const r = await fetch(config.url + route);
      assert.equal(r.status, 200);
      return (await r.json()).data;
    };
    const chinese = await get("/api/v1/works?q=" + encodeURIComponent("中"));
    assert.ok(chinese.total > 0);
    assert.ok(
      (await get("/api/v1/works?q=" + encodeURIComponent("中文"))).total > 0,
    );
    const tag = dbRead(
      demo.config,
      (db) =>
        db
          .prepare("SELECT display_value FROM tags WHERE work_count>0 LIMIT 1")
          .get().display_value,
    );
    const tagOnly = await get("/api/v1/works?tag=" + encodeURIComponent(tag));
    assert.ok(tagOnly.total > 0);
    assert.ok(tagOnly.items.every((w) => w.tags.some((t) => t.label === tag)));
    assert.equal(
      (
        await get(
          "/api/v1/works?q=definitelynotpresent&tag=" + encodeURIComponent(tag),
        )
      ).total,
      0,
    );
    assert.equal((await get("/api/v1/works?mediaType=video")).total, 0);
    const firstPage = await get("/api/v1/works?pageSize=5"),
      secondPage = await get(
        "/api/v1/works?pageSize=5&cursor=" + firstPage.cursor,
      );
    assert.equal(
      new Set([...firstPage.items, ...secondPage.items].map((w) => w.id)).size,
      10,
    );
    const mediaURL = config.url + detail.data.media[0].url;
    assert.equal((await fetch(mediaURL, { method: "HEAD" })).status, 200);
    assert.equal(
      (await fetch(mediaURL, { headers: { Range: "bytes=0-3" } })).status,
      206,
    );
    const before = dbRead(demo.config, (db) =>
      db
        .prepare("SELECT work_id,relative_path FROM works ORDER BY work_id")
        .all(),
    );
    const second = await scan(demo.config);
    assert.equal(second.code, 0, JSON.stringify(second));
    assert.deepEqual(
      dbRead(demo.config, (db) =>
        db
          .prepare("SELECT work_id,relative_path FROM works ORDER BY work_id")
          .all(),
      ),
      before,
    );
    assert.equal(second.last.counts.nativeDirectoryReads, 169);
    // Native-confirmed absence is applied on a complete full pass, not at fetch time.
    const target = path.join(
      demo.config.sources.pixiv,
      "700",
      "2026-01-01_00-00-00_duplicate",
      "10.png",
    );
    fs.unlinkSync(target);
    const removed = await scan(demo.config);
    assert.equal(removed.code, 0, JSON.stringify(removed));
    assert.equal(
      dbRead(
        demo.config,
        (db) => db.prepare("SELECT count(*) n FROM media").get().n,
      ),
      283,
    );
    const cancel = await scan(demo.config, { delay: 150, cancelAt: 1 });
    assert.equal(cancel.code, 1);
    assert.equal(cancel.last.state, "CANCELLED");
    assert.ok(
      dbRead(
        demo.config,
        (db) => db.prepare("SELECT count(*) n FROM works").get().n,
      ) >= 71,
    );
    let killed = false;
    const crash = await scan(demo.config, {
      delay: 150,
      onProgress: (s, owned) => {
        if (s.counts.worksCommitted && !killed) {
          killed = true;
          owned.kill();
        }
      },
    });
    assert.ok(killed);
    assert.notEqual(crash.code, 0);
    dbRead(demo.config, (db) => {
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
    });
    const recovered = await scan(demo.config);
    assert.equal(recovered.code, 0, JSON.stringify(recovered));
    const summary = {
      synthetic: true,
      platforms: 9,
      works: 71,
      media: 283,
      apiPolls: polls,
      apiErrors: errors,
      maxApiMs: Math.round(max),
      confirmedDuringScan: during,
      nativeDirectoryReads: first.last.counts.nativeDirectoryReads,
      repeatIdentity: true,
      cancellation: true,
    };
    fs.writeFileSync(
      path.join(root, "result.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
  },
);
test(
  "Go indexed reconciliation crosses work and author pages without dropping live entities",
  { timeout: 120000 },
  async (t) => {
    const root = path.join(testRoot, "GalleryGoReconcile-Test-") + Date.now();
    const demo = await prepare(root);
    const source = demo.config.sources.pixiv;
    const directory = (i) =>
      path.join(
        source,
        "synthetic-bulk",
        "synthetic-" + String(i).padStart(4, "0"),
      );
    for (let i = 519; i >= 0; i--) {
      const dir = directory(i);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "1.png"), Buffer.from("synthetic media"));
      fs.writeFileSync(
        path.join(dir, "metadata.json"),
        JSON.stringify({ id: "same", title: "Synthetic " + i }),
      );
    }
    for (let i = 0; i < 270; i++)
      fs.mkdirSync(
        path.join(source, "synthetic-empty-" + String(i).padStart(4, "0")),
        { recursive: true },
      );
    const first = await scan(demo.config);
    assert.equal(first.code, 0, JSON.stringify(first.last));
    const before = dbRead(demo.config, (db) => ({
      works: db.prepare("SELECT count(*) n FROM works").get().n,
      authors: db.prepare("SELECT count(*) n FROM authors").get().n,
      identities: db
        .prepare("SELECT work_id,relative_path_key FROM works ORDER BY work_id")
        .all(),
    }));
    assert.equal(before.works, 591);
    const removedKeys = new Set();
    for (let i = 0; i < 520; i++)
      if (i % 127 !== 0) {
        removedKeys.add(path.relative(source, directory(i)).toLowerCase());
        fs.rmSync(directory(i), { recursive: true });
      }
    for (let i = 0; i < 270; i++)
      if (i % 129 !== 0)
        fs.rmdirSync(
          path.join(source, "synthetic-empty-" + String(i).padStart(4, "0")),
        );
    const removed = await scan(demo.config);
    assert.equal(removed.code, 0, JSON.stringify(removed.last));
    assert.equal(removed.last.counts.worksDeleted, removedKeys.size);
    dbRead(demo.config, (db) => {
      const rows = db
        .prepare("SELECT work_id,relative_path_key FROM works ORDER BY work_id")
        .all();
      assert.deepEqual(
        rows,
        before.identities.filter((w) => !removedKeys.has(w.relative_path_key)),
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM authors").get().n,
        before.authors - 267,
      );
      db.defaultSafeIntegers(true);
      verifyCatalogContract(db, { allowLive: true });
    });
    console.log(
      JSON.stringify({
        synthetic: true,
        indexedReconcile: true,
        initialWorks: 591,
        deletedWorks: removedKeys.size,
        deletedEmptyAuthors: 267,
        nativeAbsenceConfirmed: true,
      }),
    );
  },
);
module.exports = { scan };
