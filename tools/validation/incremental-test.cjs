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
function dbRead(config, fn) {
  const db = new Database(
    path.join(config.instanceRoot, "live/catalog.sqlite"),
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function revision(c) {
  return dbRead(
    c,
    (db) => db.prepare("SELECT revision FROM live_meta").get().revision,
  );
}
function verify(c) {
  dbRead(c, (db) => {
    db.defaultSafeIntegers(true);
    verifyCatalogContract(db, { allowLive: true });
  });
}
function work(root, author, name, raw) {
  const dir = path.join(root, author, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.png"), "synthetic image");
  if (raw !== null) fs.writeFileSync(path.join(dir, "metadata.json"), raw);
  return dir;
}
function removeSynthetic(config, target) {
  const root = path.resolve(config.instanceRoot, ".."),
    resolved = path.resolve(target);
  assert.ok(
    root.startsWith(path.resolve(testRoot) + path.sep) &&
      path.basename(root).startsWith("GalleryGoIncremental-"),
  );
  assert.ok(resolved.startsWith(path.join(root, "sources") + path.sep));
  fs.rmSync(resolved, { recursive: true });
}
async function success(c, input = {}) {
  const r = await scan(c, { mode: "incremental", ...input });
  assert.equal(r.code, 0, r.error + JSON.stringify(r.last));
  assert.equal(r.last.state, "COMPLETE");
  verify(c);
  return r.last;
}
function facts(c) {
  return dbRead(c, (db) => ({
    works: db
      .prepare(
        "SELECT platform_id,relative_path_key,source_work_id,title,metadata_state,media_count FROM works ORDER BY platform_id,relative_path_key",
      )
      .all(),
    authors: db
      .prepare(
        "SELECT platform_id,relative_path_key,display_name,work_count,profile_state FROM authors ORDER BY platform_id,relative_path_key",
      )
      .all(),
    stats: db.prepare("SELECT works,media,authors FROM live_stats").get(),
    search: db.prepare("SELECT count(*) n FROM live_search_docs").get().n,
  }));
}

test(
  "Incremental nine-platform first run, unchanged reuse, legacy signatures and version invalidation",
  { timeout: 120000 },
  async () => {
    const demo = await prepare(
        path.join(testRoot, "GalleryGoIncremental-First-") + Date.now(),
      ),
      c = demo.config;
    const first = await success(c);
    assert.equal(first.counts.worksCommitted, 71);
    assert.equal(first.counts.worksReused, 0);
    const original = facts(c),
      rev = revision(c);
    const unchanged = await success(c);
    assert.equal(unchanged.counts.worksReused, 71);
    assert.equal(unchanged.counts.metadataReads, 0);
    assert.equal(unchanged.counts.worksCommitted, 0);
    assert.equal(unchanged.counts.writeTransactions, 0);
    assert.equal(revision(c), rev);
    assert.deepEqual(facts(c), original);
    // Known pre-incremental Go full scans used the identical raw directory hash.
    dbRead(c, (db) => {
      db.exec(
        "UPDATE live_scan_works SET fingerprint=substr(fingerprint,instr(fingerprint,':')+1);DELETE FROM live_scan_authors",
      );
    });
    const bridged = await success(c);
    assert.equal(bridged.counts.worksReused, 71);
    assert.equal(bridged.counts.worksCommitted, 0);
    assert.equal(
      revision(c),
      rev,
      "author bookkeeping must not advertise new content",
    );
    const afterBridge = await success(c);
    assert.equal(afterBridge.counts.metadataReads, 0);
    assert.equal(afterBridge.counts.writeTransactions, 0);
    dbRead(c, (db) => {
      db.exec(
        "UPDATE live_scan_works SET adapter_version=0 WHERE platform_id='pixiv';UPDATE live_scan_works SET fingerprint='future-format' WHERE platform_id='Venera'",
      );
    });
    const invalidated = await success(c);
    assert.equal(invalidated.counts.worksCommitted, 12);
    assert.equal(invalidated.counts.worksReused, 59);
    assert.deepEqual(facts(c), original);
    const full = await success(c, { mode: "full" });
    assert.equal(full.counts.worksReused, 0);
    assert.equal(full.counts.worksCommitted, 71);
    console.log(
      JSON.stringify({
        synthetic: true,
        first: 71,
        unchangedReused: 71,
        unchangedMetadataReads: 0,
        unchangedWrites: 0,
        versionInvalidation: true,
        legacyGoBridge: true,
      }),
    );
  },
);

test(
  "Incremental modifications, moves, deletions, nested signatures, profile authority and scoped isolation",
  { timeout: 120000 },
  async () => {
    const demo = await prepare(
        path.join(testRoot, "GalleryGoIncremental-Changes-") + Date.now(),
      ),
      c = demo.config,
      root = c.sources.pixiv;
    const raw = (id, title, name, date) =>
      JSON.stringify({
        id,
        title,
        user: { id: "900", name },
        create_date: date,
        tags: ["synthetic"],
      });
    const a = work(
      root,
      "Synthetic profile",
      "1",
      raw("9001", "First", "Early", "2020-01-01T00:00:00Z"),
    );
    const b = work(
      root,
      "Synthetic profile",
      "2",
      raw("9002", "Second", "Latest", "2026-01-01T00:00:00Z"),
    );
    await success(c);
    const get = () =>
      dbRead(c, (db) =>
        db
          .prepare(
            "SELECT display_name,profile_state,work_count FROM authors WHERE platform_id='pixiv' AND relative_path_key='synthetic profile'",
          )
          .get(),
      );
    assert.equal(get().display_name, "Latest");
    const ids = dbRead(c, (db) =>
      db
        .prepare(
          "SELECT work_id,relative_path_key FROM works WHERE platform_id='pixiv'",
        )
        .all(),
    );
    // Change nested media while restoring both ancestor mtimes: directory mtime alone is insufficient.
    const st = fs.statSync(a),
      ast = fs.statSync(path.dirname(a));
    fs.mkdirSync(path.join(a, "nested"));
    fs.writeFileSync(path.join(a, "nested", "10.png"), "new nested synthetic");
    fs.utimesSync(a, st.atime, st.mtime);
    fs.utimesSync(path.dirname(a), ast.atime, ast.mtime);
    const nested = await success(c);
    assert.equal(nested.counts.worksCommitted, 1);
    assert.equal(
      get().display_name,
      "Latest",
      "unchanged newer anchor must beat changed older work",
    );
    assert.ok(
      nested.counts.metadataReads <= 2,
      "only changed work and necessary profile anchor may be read",
    );
    fs.writeFileSync(
      path.join(b, "metadata.json"),
      raw("9002", "Second changed", "Now older", "2018-01-01T00:00:00Z"),
    );
    await success(c);
    assert.equal(
      get().display_name,
      "Early",
      "former newest becoming older must reselect all observed candidates",
    );
    removeSynthetic(c, a);
    await success(c);
    assert.equal(
      get().display_name,
      "Now older",
      "deleted anchor must fall back to an unchanged work",
    );
    fs.renameSync(b, path.join(path.dirname(b), "moved"));
    const moved = await success(c);
    assert.equal(moved.counts.worksAdded, 1);
    assert.equal(moved.counts.worksDeleted, 1);
    for (const old of ids.filter(
      (x) => !x.relative_path_key.startsWith("synthetic profile\\"),
    )) {
      assert.equal(
        dbRead(
          c,
          (db) =>
            db
              .prepare(
                "SELECT work_id FROM works WHERE platform_id=? AND relative_path_key=?",
              )
              .get("pixiv", old.relative_path_key).work_id,
        ),
        old.work_id,
      );
    }
    // Empty author remains physical, but old profile and latest-work pointer must disappear.
    removeSynthetic(c, path.join(root, "Synthetic profile", "moved"));
    await success(c);
    assert.deepEqual(get(), {
      display_name: "Synthetic profile",
      profile_state: "unavailable",
      work_count: 0,
    });
    const removed = path.join(c.sources.X, "700");
    removeSynthetic(c, removed);
    const scoped = await success(c, {
      platformIds: ["pixiv"],
      authorDirectoryName: "Synthetic profile",
    });
    assert.equal(scoped.counts.worksPrepared, 0);
    assert.ok(
      facts(c).works.some((w) => w.platform_id === "X"),
      "unselected platform cannot be reconciled",
    );
    const untouched = facts(c).works.filter((w) => w.platform_id === "pixiv");
    removeSynthetic(c, path.join(root, "Synthetic profile"));
    await success(c, {
      platformIds: ["pixiv"],
      authorDirectoryName: "Synthetic profile",
    });
    assert.deepEqual(
      facts(c).works.filter((w) => w.platform_id === "pixiv"),
      untouched,
      "author-scoped deletion must not delete other authors",
    );
    assert.equal(get(), undefined);
    const finished = await success(c);
    assert.ok(finished.counts.worksDeleted > 0);
    assert.ok(!facts(c).works.some((w) => w.platform_id === "X"));
    // A full re-extraction produces the same public facts as incremental edits.
    const before = facts(c);
    await success(c, { mode: "full" });
    assert.deepEqual(facts(c), before);
    console.log(
      JSON.stringify({
        synthetic: true,
        nestedUnchangedParents: true,
        profileReselection: true,
        emptyAuthor: true,
        moveIdentity: true,
        scopes: true,
        fullParity: true,
      }),
    );
  },
);

test(
  "Incremental incomplete scope, malformed metadata, source collisions, cancellation and crash recovery",
  { timeout: 120000 },
  async () => {
    const demo = await prepare(
        path.join(testRoot, "GalleryGoIncremental-Safety-") + Date.now(),
      ),
      c = demo.config,
      root = c.sources.pixiv;
    const a = work(
        root,
        "Synthetic safety",
        "1",
        '{"id":"900900","title":"synthetic safe"}',
      ),
      b = work(root, "Synthetic safety", "2", "{broken");
    await success(c);
    const before = facts(c),
      rev = revision(c);
    const outside = path.join(demo.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(a, "linked"), "junction");
    fs.unlinkSync(path.join(a, "1.png"));
    const failed = await scan(c, {
      mode: "incremental",
      platformIds: ["pixiv"],
    });
    assert.equal(failed.code, 1);
    assert.equal(failed.last.state, "FAILED");
    assert.deepEqual(facts(c), before);
    assert.equal(revision(c), rev);
    fs.unlinkSync(path.join(a, "linked"));
    fs.writeFileSync(path.join(b, "metadata.json"), "[1,2]");
    fs.writeFileSync(path.join(a, "1.png"), "restored synthetic");
    work(
      root,
      "Synthetic safety",
      "3",
      '{"id":"900900","title":"synthetic collision"}',
    );
    await success(c);
    assert.equal(
      dbRead(
        c,
        (db) =>
          db
            .prepare(
              "SELECT count(*) n FROM works WHERE platform_id='pixiv' AND source_work_id='900900'",
            )
            .get().n,
      ),
      2,
    );
    const prior = facts(c);
    fs.writeFileSync(path.join(b, "metadata.json"), "{}");
    const cancelled = await scan(c, {
      mode: "incremental",
      platformIds: ["pixiv"],
      delay: 1000,
      onProgress: (s, child) => {
        if (s.running && s.counts.worksPrepared >= 1)
          child.stdin.write("cancel\n");
      },
    });
    assert.equal(cancelled.code, 1);
    assert.equal(cancelled.last.state, "CANCELLED");
    assert.deepEqual(facts(c), prior);
    await success(c);
    fs.writeFileSync(path.join(b, "metadata.json"), "{broken again");
    let killed = false;
    const crash = await scan(c, {
      mode: "incremental",
      platformIds: ["pixiv"],
      delay: 1000,
      onProgress: (s, child) => {
        if (s.running && s.counts.worksPrepared >= 1 && !killed) {
          killed = true;
          child.kill();
        }
      },
    });
    assert.ok(killed);
    assert.notEqual(crash.code, 0);
    verify(c);
    const recovered = await success(c);
    assert.equal(
      recovered.counts.worksCommitted,
      1,
      "uncommitted extraction cannot qualify reuse",
    );
    const stable = await success(c);
    assert.equal(stable.counts.worksCommitted, 0);
    assert.equal(stable.counts.metadataReads, 0);
    console.log(
      JSON.stringify({
        synthetic: true,
        incompleteScopeProtection: true,
        malformedPhysicalRetention: true,
        sourceCollisionRetention: true,
        cancellation: true,
        crashRecovery: true,
      }),
    );
  },
);
