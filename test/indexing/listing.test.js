"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { everythingServer } = require("../support/everything.js");
const { normalizeRuntimeConfig } = require("../../src/instance/config.js");
const { fullScan } = require("../../src/indexing/task.js");
const { openLive, getLiveState } = require("../../src/catalog/live.js");
const { ASYNC_IO } = require("../../src/library/scan-producer.js");
const { createRuntimeBootstrap } = require("../../src/runtime/bootstrap.js");
const Database = require("better-sqlite3");
const {
  createListingSession,
  prepareListingQueries,
} = require("../../src/indexing/listing.js");
async function setup(t) {
  const f = await fixture(t),
    provider = await everythingServer(t, f.bindings);
  f.config = normalizeRuntimeConfig({
    instanceRoot: f.config.instanceRoot,
    sources: f.bindings,
    port: f.config.port,
    liveUpdates: true,
    everything: { endpoint: provider.endpoint },
    retention: { enabled: false },
  });
  return { f, provider };
}
function scan(f, id, options = {}) {
  return fullScan(f.config, {
    confirmReadOnly: true,
    generationId: id,
    concurrency: { disks: [], unknownIo: 4 },
    batchSize: 2,
    ...options,
  });
}
function read(f, fn) {
  const live = openLive(f.config, null);
  try {
    return fn(live.db);
  } finally {
    live.close();
  }
}
function counts(f) {
  return read(f, (db) =>
    db.prepare("SELECT works,media,authors FROM live_stats").get(),
  );
}

test("listing lookups seek parent, author and work indexes without scanning an entire platform", async (t) => {
  const f = await fixture(t, { empty: true }),
    ledger = new Database(":memory:");
  ledger.exec(
    "CREATE TABLE live_scan_works(platform_id,relative_path_key,fingerprint,adapter_version); CREATE TABLE live_scan_authors(platform_id,relative_path_key,fingerprint);",
  );
  const session = createListingSession({ config: f.config, database: ledger });
  const file = path.join(
    f.config.stateRoot,
    "indexing",
    fs.readdirSync(path.join(f.config.stateRoot, "indexing"))[0],
  );
  const spool = new Database(file);
  try {
    const put = spool.prepare(
      "INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    spool.transaction(() => {
      for (let a = 0; a < 100; a++) {
        const author = "author-" + String(a).padStart(3, "0");
        put.run(
          "pixiv",
          author,
          author,
          ".",
          "folder",
          "0",
          "1",
          author,
          null,
          author,
        );
        for (let w = 0; w < 100; w++) {
          const name = "work-" + String(w).padStart(3, "0"),
            work = author + "\\" + name;
          put.run(
            "pixiv",
            work,
            work,
            author,
            "folder",
            "0",
            "1",
            author,
            work,
            name,
          );
          for (let p = 0; p < 5; p++) {
            const name = p + ".png",
              key = work + "\\" + name;
            put.run(
              "pixiv",
              key,
              key,
              work,
              "file",
              "100",
              "1",
              author,
              work,
              name,
            );
          }
        }
      }
    })();
    const queries = prepareListingQueries(spool),
      scope = {
        authors: ["entries_parent", ["pixiv", ""]],
        authorFingerprint: ["entries_author", ["pixiv", "author-010"]],
        workDirectories: ["entries_parent", ["pixiv", "author-010"]],
        workFingerprint: ["entries_work", ["pixiv", "author-010\\work-003"]],
        workEntries: ["entries_work", ["pixiv", "author-010\\work-003"]],
      };
    for (const [name, [index, args]] of Object.entries(scope)) {
      const plan = spool
        .prepare("EXPLAIN QUERY PLAN " + queries[name].source)
        .all(...args)
        .map((row) => row.detail)
        .join("\n");
      assert.match(
        plan,
        new RegExp(
          "SEARCH entries USING (?:COVERING )?INDEX " +
            index +
            " \\(platform=\\? AND ",
        ),
      );
      assert.doesNotMatch(plan, /SCAN entries|PRIMARY KEY|TEMP B-TREE/);
    }
    const page = queries.authors.all("pixiv", "");
    assert.equal(page.length, 64);
    assert.equal(queries.authors.all("pixiv", page.at(-1).key).length, 36);
    assert.equal(
      queries.workDirectories.all("pixiv", "author-010").length,
      100,
    );
    const work = queries.workEntries.all("pixiv", "author-010\\work-003");
    assert.equal(work.length, 6);
    assert.ok(work.every((row) => row.work === "author-010\\work-003"));
    assert.equal(
      queries.authorFingerprint.all("pixiv", "author-010").length,
      601,
    );
    assert.deepEqual(
      queries.workFingerprint.all("pixiv", "author-010\\work-003"),
      work.map(({ key, relative, kind, size, mtime }) => ({
        key,
        relative,
        kind,
        size,
        mtime,
      })),
    );
  } finally {
    spool.close();
    session.close();
    ledger.close();
  }
});

test("first listing scan is visible through the running HTTP reader before scan completion, with no candidate or checkpoint", async (t) => {
  const { f } = await setup(t),
    runtime = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => runtime.close());
  await runtime.start();
  let firstBatch = false;
  const result = await scan(f, "initial-listing", {
    onCommittedBatch: async ({ mappedCandidates }) => {
      if (firstBatch || !mappedCandidates.length) return;
      firstBatch = true;
      const status = JSON.parse(fs.readFileSync(f.config.scanStatusPath));
      assert.equal(status.running, true);
      const response = await fetch(f.config.url + "/api/v1/works");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.data.total > 0 && body.data.total < 6);
      const search = await (
        await fetch(f.config.url + "/api/v1/works?q=Alpha")
      ).json();
      assert.equal(search.data.total, 1);
    },
  });
  assert.equal(firstBatch, true);
  assert.equal(result.updateStrategy, "live");
  assert.equal(result.searchRebuilt, false);
  assert.equal(result.build.counts.works, 6);
  assert.equal(result.build.counts.media, 7);
  assert.equal(result.sourceWriteAttempts, 0);
  assert.equal(result.inventory.workListingReads, 6);
  assert.equal(result.inventory.workFingerprintReads, 0);
  assert.equal(fs.existsSync(f.config.activeGenerationPath), false);
  assert.deepEqual(fs.readdirSync(f.config.generationsRoot), []);
  const state = await (await fetch(f.config.url + "/api/v1/status")).json();
  assert.equal(state.data.libraryReady, true);
  assert.equal(state.data.restartRequired, false);
  assert.equal(state.data.live.baseGenerationId, null);
  assert.equal(state.data.counts.works, 6);
});

test("unchanged inventory reuses committed works without directory enumeration, media stat or metadata reads", async (t) => {
  const { f } = await setup(t);
  await scan(f, "base");
  const before = read(f, getLiveState);
  const reads = [],
    stats = [],
    io = {
      ...ASYNC_IO,
      readdir() {
        throw new Error("Native enumeration must not occur");
      },
      readFile(target) {
        reads.push(target);
        return ASYNC_IO.readFile(target);
      },
      lstat(target) {
        stats.push(target);
        return ASYNC_IO.lstat(target);
      },
    };
  const result = await scan(f, "unchanged", { mode: "incremental", io });
  assert.equal(result.changes.worksReused, 6);
  assert.equal(result.changes.metadataRead, 0);
  assert.equal(result.inventory.metadataReads, 0);
  assert.equal(reads.length, 0);
  assert.equal(result.inventory.nativeDirectoryReads, 0);
  assert.ok(stats.every((target) => !/[.](png|jpg|webm|json)$/i.test(target)));
  assert.equal(result.inventory.workListingReads, 6);
  assert.equal(result.inventory.workFingerprintReads, 0);
  assert.equal(
    read(
      f,
      (db) => db.prepare("SELECT count(*) n FROM live_scan_works").get().n,
    ),
    6n,
  );
  assert.equal(read(f, getLiveState).revision, before.revision);
});

test("one platform can ingest multiple listing chunks while another awaits work without leaving a busy SQLite iterator", async (t) => {
  const { f, provider } = await setup(t);
  for (let i = 0; i < 300; i++)
    f.work(
      "chunk-" + i,
      { id: String(i), title: "Chunk sample" },
      undefined,
      "chunk-author",
      "X",
    );
  provider.controls.delay = 10;
  const result = await scan(f, "interleaved-listings");
  assert.equal(result.build.counts.works, 306);
  assert.equal(result.inventory.nativeDirectoryReads, 0);
  const next = await scan(f, "reuse-interleaved", { mode: "incremental" });
  assert.equal(next.changes.worksReused, 306);
  assert.equal(next.inventory.metadataReads, 0);
});

test("file fingerprints detect changed metadata even when all directory mtimes are unchanged; duplicates and malformed works survive", async (t) => {
  const { f } = await setup(t);
  await scan(f, "base");
  const author = path.join(f.bindings.pixiv, "100"),
    work = path.join(author, "2026-01-01_00-00-00_1"),
    before = fs.statSync(work),
    authorBefore = fs.statSync(author);
  fs.writeFileSync(
    path.join(work, "metadata.json"),
    JSON.stringify({
      id: "same",
      title: "Changed only metadata",
      user: { id: "100", name: "Synthetic profile" },
    }),
  );
  fs.utimesSync(work, before.atime, before.mtime);
  fs.utimesSync(author, authorBefore.atime, authorBefore.mtime);
  const result = await scan(f, "changed", { mode: "incremental" });
  assert.equal(result.build.counts.works, 6);
  assert.ok(result.inventory.metadataReads <= 2);
  assert.equal(
    read(
      f,
      (db) =>
        db
          .prepare(
            "SELECT count(*) n FROM works WHERE title='Changed only metadata'",
          )
          .get().n,
    ),
    1n,
  );
  assert.equal(
    read(
      f,
      (db) =>
        db
          .prepare("SELECT count(*) n FROM works WHERE source_work_id='same'")
          .get().n,
    ),
    2n,
  );
  assert.equal(result.build.counts.media, 7);
});

test("cancel retains the committed work ledger and resumes without clearing confirmed work", async (t) => {
  const { f } = await setup(t);
  let requested = false;
  await assert.rejects(
    scan(f, "cancel", {
      onCommittedBatch: ({ mappedCandidates }) => {
        if (requested || !mappedCandidates.length) return;
        requested = true;
        fs.writeFileSync(
          path.join(f.config.stateRoot, "scan-cancel.json"),
          JSON.stringify({ generationId: "cancel" }),
        );
      },
    }),
    { code: "SCAN_CANCELLED" },
  );
  const retained = counts(f).works;
  assert.ok(retained > 0n && retained < 6n);
  assert.equal(
    read(
      f,
      (db) => db.prepare("SELECT count(*) n FROM live_scan_works").get().n,
    ),
    retained,
  );
  const result = await scan(f, "resume", { mode: "incremental" });
  assert.equal(result.build.counts.works, 6);
  assert.ok(result.changes.worksReused > 0);
});

test("a truncated response cannot delete old works or advance their ledger", async (t) => {
  const { f, provider } = await setup(t);
  await scan(f, "base");
  const before = read(f, getLiveState);
  provider.controls.truncate = true;
  await assert.rejects(
    scan(f, "truncated", { mode: "incremental" }),
    /EVERYTHING_/,
  );
  assert.equal(counts(f).works, 6n);
  assert.equal(read(f, getLiveState).revision, before.revision);
});

test("complete scoped deletion updates Catalog, Search, counts and revision together, never deleting an indexed omission on disk", async (t) => {
  const { f, provider } = await setup(t);
  await scan(f, "base");
  const directory = path.join(f.bindings.pixiv, "100", "2026-01-01_00-00-00_1");
  fs.rmSync(directory, { recursive: true });
  await scan(f, "delete", { mode: "incremental", platformId: "pixiv" });
  assert.equal(counts(f).works, 5n);
  assert.equal(counts(f).media, 6n);
  assert.equal(
    read(
      f,
      (db) =>
        db
          .prepare(
            "SELECT count(*) n FROM live_search_docs WHERE title LIKE '%alpha%'",
          )
          .get().n,
    ),
    0n,
  );
  assert.equal(
    read(
      f,
      (db) => db.prepare("SELECT count(*) n FROM live_scan_works").get().n,
    ),
    5n,
  );
  provider.controls.matchTransformedTotal = true;
  provider.controls.transform = (rows) =>
    rows.filter(
      (row) => !path.join(row.path, row.name).includes("2026-01-02_00-00-00_2"),
    );
  await assert.rejects(
    scan(f, "omitted", { mode: "incremental", platformId: "pixiv" }),
    { code: "EVERYTHING_MISSING_EXISTING_PATH" },
  );
  assert.equal(counts(f).works, 5n);
});

test("an incomplete changed work preserves old actual media and never gains a committed fingerprint", async (t) => {
  const { f } = await setup(t);
  await scan(f, "base");
  const target = path.join(
    f.bindings.pixiv,
    "100",
    "2026-01-01_00-00-00_1",
    "new.png",
  );
  fs.writeFileSync(target, f.PNG);
  const signature = read(
    f,
    (db) =>
      db
        .prepare(
          "SELECT fingerprint FROM live_scan_works WHERE relative_path_key=?",
        )
        .get("100\\2026-01-01_00-00-00_1").fingerprint,
  );
  const io = {
    ...ASYNC_IO,
    lstat(file) {
      if (file === target)
        throw Object.assign(new Error("synthetic unreadable"), {
          code: "EACCES",
        });
      return ASYNC_IO.lstat(file);
    },
  };
  await assert.rejects(
    scan(f, "incomplete", { mode: "incremental", platformId: "pixiv", io }),
    { code: "CATALOG_INCOMPLETE" },
  );
  assert.equal(counts(f).media, 7n);
  assert.equal(
    read(
      f,
      (db) =>
        db
          .prepare(
            "SELECT fingerprint FROM live_scan_works WHERE relative_path_key=?",
          )
          .get("100\\2026-01-01_00-00-00_1").fingerprint,
    ),
    signature,
  );
});

test("restart without an active generation reopens the same committed working database", async (t) => {
  const { f } = await setup(t);
  await scan(f, "base");
  const epoch = read(f, getLiveState).epoch;
  const runtime = createRuntimeBootstrap({ config: f.config });
  await runtime.start();
  assert.equal(runtime.status().live.epoch, epoch);
  await runtime.close();
  const reopened = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => reopened.close());
  await reopened.start();
  assert.equal(reopened.status().live.epoch, epoch);
  const page = await (await fetch(f.config.url + "/api/v1/works")).json();
  assert.equal(page.data.total, 6);
});

test("Manager diagnostics checks the live working database without requiring a READY generation", async (t) => {
  const { f } = await setup(t);
  const file = path.join(f.config.instanceRoot, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      instanceRoot: f.config.instanceRoot,
      sources: f.bindings,
      port: f.config.port,
      liveUpdates: true,
      everything: f.config.everything,
    }),
  );
  await scan(f, "base");
  const result = await require("../../src/runtime/management.js").manage(
    file,
    "diagnostics.run",
  );
  assert.ok(!result.findings.some((row) => /GENERATION|LIVE_/.test(row.code)));
  const catalog = result.checks.find((row) => row.valid === true);
  assert.equal(catalog.works, 6);
  assert.equal(catalog.generation, read(f, getLiveState).epoch);
});

test("an omitted existing media file cannot be deleted from a complete-looking listing", async (t) => {
  const { f, provider } = await setup(t);
  await scan(f, "base");
  provider.controls.matchTransformedTotal = true;
  provider.controls.transform = (rows) =>
    rows.filter((row) => row.name !== "other.jpg");
  await assert.rejects(
    scan(f, "media-omission", { mode: "incremental", platformId: "pixiv" }),
    { code: "CATALOG_INCOMPLETE" },
  );
  assert.equal(counts(f).media, 7n);
  provider.controls.transform = null;
  fs.unlinkSync(
    path.join(f.bindings.pixiv, "100", "2026-01-02_00-00-00_2", "other.jpg"),
  );
  const result = await scan(f, "actual-removal", {
    mode: "incremental",
    platformId: "pixiv",
  });
  assert.equal(result.build.counts.media, 6);
  assert.equal(counts(f).works, 6n);
});

test("changed latest metadata becoming older selects the highest unchanged profile anchor without rereading every work", async (t) => {
  const { f } = await setup(t);
  f.work(
    "older",
    {
      id: "old",
      date: "2025-01-01T00:00:00Z",
      user: { id: "profile-test", name: "Older profile" },
    },
    undefined,
    "profile-test",
  );
  const newer = f.work(
    "newer",
    {
      id: "new",
      date: "2029-01-01T00:00:00Z",
      user: { id: "profile-test", name: "Newer profile" },
    },
    undefined,
    "profile-test",
  );
  await scan(f, "base");
  fs.writeFileSync(
    path.join(newer, "metadata.json"),
    JSON.stringify({
      id: "new",
      date: "2020-01-01T00:00:00Z",
      user: { id: "profile-test", name: "Now older" },
    }),
  );
  const result = await scan(f, "authority-change", {
    mode: "incremental",
    platformId: "pixiv",
  });
  assert.ok(result.inventory.metadataReads <= 2);
  assert.equal(
    read(
      f,
      (db) =>
        db
          .prepare(
            "SELECT display_name FROM authors WHERE relative_path_key='profile-test'",
          )
          .get().display_name,
    ),
    "Older profile",
  );
});
