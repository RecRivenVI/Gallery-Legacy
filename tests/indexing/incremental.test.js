"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const { fixture } = require("../support/runtime.js");
const { NODE_FS_IO } = require("../../internal/library/observer.js");
const { fullScan } = require("../../internal/indexing/task.js");
const { buildCatalog } = require("../../internal/indexing/build.js");
const { updateCatalog } = require("../../internal/indexing/incremental.js");
const { verifyCatalogContract } = require("../../internal/catalog/writer.js");
const { PLATFORM_REGISTRY } = require("../../internal/library/platforms.js");
const { stableJson } = require("../../internal/catalog/stable-json.js");
const { resolveActiveGeneration } = require("../../internal/publication/generations.js");
const { hashDatabaseFile } = require("../../internal/catalog/file-hash.js");

function active(config) {
  return resolveActiveGeneration(config.instanceRoot, {
    generationsRoot: config.generationsRoot,
    activePointerPath: config.activeGenerationPath,
  });
}

function rows(file, sql, ...params) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  try { return db.prepare(sql).all(...params); }
  finally { db.close(); }
}

function physicalSnapshot(file) {
  return rows(file, `SELECT w.platform_id,a.relative_path_key AS author_key,w.relative_path_key AS work_key,
    w.source_work_id,w.title,w.metadata_state,w.adapter_version,w.media_count,w.image_count,w.video_count
    FROM works w JOIN authors a ON a.author_id=w.author_id ORDER BY w.platform_id,a.relative_path_key,w.relative_path_key`);
}

describe("incremental and scoped scans", { concurrency: false }, () => {
test("unchanged incremental scan reuses work facts, rebuilds Search, and never mutates the READY baseline", async (t) => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  f.work(
    "2027-01-01_00-00-00_1",
    { id: "cache-1", title: "Cache older", user: { id: "cache" } },
    undefined,
    "cache-author",
  );
  f.work(
    "2028-01-01_00-00-00_2",
    { id: "cache-2", title: "Cache latest", user: { id: "cache" } },
    undefined,
    "cache-author",
  );
  await fullScan(f.config, { confirmReadOnly: true, generationId: "baseline" });
  const baseline = active(f.config);
  const beforeHash = hashDatabaseFile(baseline.catalogPath);
  const report = await fullScan(f.config, { confirmReadOnly: true, generationId: "unchanged", mode: "incremental" });
  assert.equal(report.state, "READY");
  assert.equal(report.mode, "incremental");
  assert.equal(report.searchRebuilt, true);
  assert.equal(report.changes.worksRebuilt, 0);
  assert.equal(report.changes.worksReused, 8);
  assert.equal(report.changes.metadataObserved, 8);
  assert.ok(report.changes.metadataReparsed > 0);
  assert.ok(report.changes.metadataReused > 0);
  assert.ok(report.changes.metadataRead < report.changes.metadataObserved);
  const status = JSON.parse(fs.readFileSync(f.config.scanStatusPath, "utf8"));
  assert.equal(status.indexedWorks, 0);
  assert.equal(status.changes.worksReused, 8);
  assert.deepEqual(status.scope.invalidatedPlatformIds, []);
  assert.equal(fs.rmSync.name, "rmSync");
  assert.equal(fs.rmdirSync.name, "rmdirSync");
  assert.equal(report.build.platforms.length, 9);
  assert.equal(hashDatabaseFile(baseline.catalogPath), beforeHash);
  assert.deepEqual(physicalSnapshot(active(f.config).catalogPath), physicalSnapshot(baseline.catalogPath));
});

test("metadata cache falls back when metadata or media facts change", async (t) => {
  const f = await fixture(t, { empty: true });
  const older = f.work(
    "2027-01-01_00-00-00_1",
    {
      id: "a",
      date: "2025-01-01T00:00:00Z",
      title: "Older",
      user: { id: "cache", name: "Older profile" },
    },
    undefined,
    "cache-author",
  );
  const latest = f.work(
    "2028-01-01_00-00-00_2",
    {
      id: "b",
      date: "2025-01-01T00:00:00Z",
      title: "Latest",
      user: { id: "cache", name: "Latest profile" },
      tags: [42],
    },
    undefined,
    "cache-author",
  );
  const baseline = path.join(f.config.tempRoot, "cache-base.sqlite");
  await buildCatalog({ catalogPath: baseline, platformRoots: f.bindings });
  const unchangedPath = path.join(f.config.tempRoot, "cache-unchanged.sqlite");
  const unchanged = await updateCatalog({
    catalogPath: unchangedPath,
    baseCatalogPath: baseline,
    platformRoots: f.bindings,
    platformId: "pixiv",
    authorDirectoryName: "cache-author",
  });
  assert.equal(unchanged.report.changes.metadataRead, 1);
  assert.equal(unchanged.report.changes.metadataReused, 1);
  assert.equal(
    rows(
      unchangedPath,
      `SELECT count(*) n FROM authors a JOIN author_profiles p USING(author_id)
       WHERE a.latest_work_id=p.authority_work_id`,
    )[0].n,
    1n,
  );
  assert.equal(
    rows(unchangedPath, "SELECT display_name FROM authors")[0].display_name,
    "Latest profile",
  );
  assert.equal(
    rows(
      unchangedPath,
      "SELECT metadata_state FROM works WHERE source_work_id='b'",
    )[0].metadata_state,
    "partial",
  );

  fs.writeFileSync(
    path.join(latest, "metadata.json"),
    JSON.stringify({
      id: "b",
      date: "2025-01-01T00:00:00Z",
      title: "Latest changed",
      user: { id: "cache", name: "Latest changed profile" },
    }),
  );
  const metadataPath = path.join(f.config.tempRoot, "cache-metadata.sqlite");
  const metadataChanged = await updateCatalog({
    catalogPath: metadataPath,
    baseCatalogPath: unchangedPath,
    platformRoots: f.bindings,
    platformId: "pixiv",
    authorDirectoryName: "cache-author",
  });
  assert.equal(metadataChanged.report.changes.metadataRead, 2);
  assert.equal(metadataChanged.report.changes.metadataReused, 0);
  assert.equal(metadataChanged.report.changes.worksRebuilt, 1);
  assert.equal(
    rows(metadataPath, "SELECT display_name FROM authors")[0].display_name,
    "Latest changed profile",
  );

  fs.writeFileSync(path.join(older, "1.png"), Buffer.from("changed-media"));
  const mediaChanged = await updateCatalog({
    catalogPath: path.join(f.config.tempRoot, "cache-media.sqlite"),
    baseCatalogPath: metadataPath,
    platformRoots: f.bindings,
    platformId: "pixiv",
    authorDirectoryName: "cache-author",
  });
  assert.equal(mediaChanged.report.changes.metadataRead, 2);
  assert.equal(mediaChanged.report.changes.metadataReused, 0);
  assert.equal(mediaChanged.report.changes.worksRebuilt, 1);

  fs.rmSync(latest, { recursive: true });
  const deletedLatest = await updateCatalog({
    catalogPath: path.join(f.config.tempRoot, "cache-delete.sqlite"),
    baseCatalogPath: mediaChanged.catalogPath,
    platformRoots: f.bindings,
    platformId: "pixiv",
    authorDirectoryName: "cache-author",
  });
  assert.equal(deletedLatest.report.changes.metadataReused, 0);
  assert.equal(deletedLatest.report.changes.worksDeleted, 1);
  assert.equal(
    rows(
      deletedLatest.catalogPath,
      "SELECT display_name FROM authors",
    )[0].display_name,
    "Older profile",
  );

  f.work(
    "2029-01-01_00-00-00_missing",
    undefined,
    undefined,
    "cache-author",
  );
  const missingLatest = await updateCatalog({
    catalogPath: path.join(f.config.tempRoot, "cache-missing.sqlite"),
    baseCatalogPath: deletedLatest.catalogPath,
    platformRoots: f.bindings,
    platformId: "pixiv",
    authorDirectoryName: "cache-author",
  });
  assert.equal(missingLatest.report.changes.metadataReused, 0);
  assert.deepEqual(
    rows(
      missingLatest.catalogPath,
      "SELECT latest_work_id,profile_state FROM authors",
    ),
    [{ latest_work_id: null, profile_state: "unavailable" }],
  );
  assert.equal(
    rows(missingLatest.catalogPath, "SELECT count(*) n FROM author_profiles")[0]
      .n,
    0n,
  );
});

test("multi-platform scope updates and deletes only selected complete platforms", async (t) => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), {
    recursive: true,
    force: true,
  });
  const gank = f.work(
    "selected-gank",
    { id: "gank-selected", title: "Gank before", user: { id: "g" } },
    undefined,
    "g",
    "Gank",
  );
  f.work(
    "outside-x",
    { id: "x-outside", title: "X before", user: { id: "x" } },
    undefined,
    "x",
    "X",
  );
  await fullScan(f.config, {
    confirmReadOnly: true,
    generationId: "multi-base",
  });
  const outsideBefore = rows(
    active(f.config).catalogPath,
    "SELECT relative_path_key,title FROM works WHERE platform_id='X' ORDER BY relative_path_key",
  );
  fs.writeFileSync(
    path.join(gank, "metadata.json"),
    JSON.stringify({
      id: "gank-selected",
      title: "Gank after",
      user: { id: "g" },
    }),
  );
  const removed = path.join(
    f.bindings.pixiv,
    "100",
    "2026-01-01_00-00-00_1",
  );
  fs.rmSync(removed, { recursive: true });
  const report = await fullScan(f.config, {
    confirmReadOnly: true,
    generationId: "multi-update",
    mode: "incremental",
    platformIds: ["Gank", "pixiv"],
  });
  assert.deepEqual(report.scope.requestedPlatformIds, ["pixiv", "Gank"]);
  assert.deepEqual(report.scope.effectivePlatformIds, ["pixiv", "Gank"]);
  assert.equal(report.changes.worksDeleted, 1);
  assert.equal(
    rows(
      active(f.config).catalogPath,
      "SELECT title FROM works WHERE platform_id='Gank'",
    )[0].title,
    "Gank after",
  );
  assert.deepEqual(
    rows(
      active(f.config).catalogPath,
      "SELECT relative_path_key,title FROM works WHERE platform_id='X' ORDER BY relative_path_key",
    ),
    outsideBefore,
  );
});

test("author-scoped incremental update preserves outside scope and handles metadata, media, add, delete, rename, collisions and authority", async (t) => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  f.work("2027-01-01_00-00-00_7", { id: "collision", date: "2027-01-01T00:00:00Z", title: "Older", user: { id: "100", name: "Older authority" } });
  const latest = f.work("2028-01-01_00-00-00_8", { id: "collision", date: "2028-01-01T00:00:00Z", title: "Latest", user: { id: "100", name: "Latest authority" } });
  f.work("outside", { id: "outside", title: "Outside author", user: { id: "200", name: "Outside" } }, undefined, "200", "pixiv");
  f.work("gank-work", { id: "gank", title: "Gank outside", user: { id: "g", name: "G" } }, undefined, "g", "Gank");
  await fullScan(f.config, { confirmReadOnly: true, generationId: "scope-base" });
  const outsideBefore = rows(active(f.config).catalogPath, "SELECT platform_id,relative_path_key,title FROM works WHERE platform_id='Gank' OR relative_path_key LIKE '200\\%'");

  fs.rmSync(latest, { recursive: true });
  const renamedFrom = path.join(f.bindings.pixiv, "100", "2026-01-02_00-00-00_2");
  const renamedTo = path.join(f.bindings.pixiv, "100", "2026-01-02_00-00-00_renamed");
  fs.renameSync(renamedFrom, renamedTo);
  fs.writeFileSync(path.join(f.bindings.pixiv, "100", "2026-01-01_00-00-00_1", "metadata.json"), JSON.stringify({ id: "collision", title: "Changed metadata", user: { id: "100", name: "Older authority" } }));
  fs.writeFileSync(path.join(f.bindings.pixiv, "100", "2026-01-01_00-00-00_1", "1.png"), Buffer.from("changed-media"));
  f.work("2026-06-01_00-00-00_new", "{", { "new.png": f.PNG }, "100", "pixiv");

  const report = await fullScan(f.config, {
    confirmReadOnly: true, generationId: "scope-update", mode: "incremental",
    platformId: "pixiv", authorDirectoryName: "100",
  });
  assert.equal(report.state, "READY");
  assert.ok(report.changes.worksRebuilt >= 3);
  assert.ok(report.changes.worksDeleted >= 2);
  assert.deepEqual(rows(active(f.config).catalogPath, "SELECT platform_id,relative_path_key,title FROM works WHERE platform_id='Gank' OR relative_path_key LIKE '200\\%'"), outsideBefore);
  const updated = rows(active(f.config).catalogPath, `SELECT w.relative_path_key,w.title,w.metadata_state,w.source_work_id,a.display_name
    FROM works w JOIN authors a ON a.author_id=w.author_id WHERE w.platform_id='pixiv' AND a.relative_path_key='100' ORDER BY w.relative_path_key`);
  assert.ok(updated.some((row) => row.title === "Changed metadata"));
  assert.ok(updated.some((row) => row.relative_path_key.endsWith("renamed")));
  assert.ok(!updated.some((row) => row.relative_path_key.endsWith("_8")));
  assert.ok(updated.some((row) => row.metadata_state === "malformed"));
  assert.ok(updated.filter((row) => row.source_work_id === "collision").length >= 2);
  assert.ok(updated.every((row) => row.display_name === "Older authority"), JSON.stringify(updated));

  const pixivBeforePlatformScope = rows(active(f.config).catalogPath, "SELECT relative_path_key,title,metadata_state,media_count FROM works WHERE platform_id='pixiv' ORDER BY relative_path_key");
  fs.writeFileSync(path.join(f.bindings.Gank, "g", "gank-work", "metadata.json"), JSON.stringify({ id: "gank", title: "Gank refreshed", user: { id: "g", name: "G" } }));
  const platformReport = await fullScan(f.config, {
    confirmReadOnly: true, generationId: "platform-full", mode: "full", platformId: "Gank",
  });
  assert.equal(platformReport.scope.requestedPlatformId, "Gank");
  assert.deepEqual(rows(active(f.config).catalogPath, "SELECT relative_path_key,title,metadata_state,media_count FROM works WHERE platform_id='pixiv' ORDER BY relative_path_key"), pixivBeforePlatformScope);
  assert.equal(rows(active(f.config).catalogPath, "SELECT title FROM works WHERE platform_id='Gank'")[0].title, "Gank refreshed");

  const full = await f.build("scope-full-equivalent");
  assert.deepEqual(physicalSnapshot(active(f.config).catalogPath), physicalSnapshot(full.catalogPath));
});

test("same mtime and size is an explicit no-hash limitation, while incomplete scope leaves active unchanged", async (t) => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  await fullScan(f.config, { confirmReadOnly: true, generationId: "limit-base" });
  const target = path.join(f.bindings.pixiv, "100", "2026-01-01_00-00-00_1", "1.png");
  const old = NODE_FS_IO.lstat(target);
  const replacement = Buffer.alloc(Number(old.size), 7);
  fs.writeFileSync(target, replacement);
  const maskedIo = {
    ...NODE_FS_IO,
    lstat(file) {
      const stat = NODE_FS_IO.lstat(file);
      if (path.resolve(file) !== path.resolve(target)) return stat;
      return {
        size: old.size, mtimeNs: old.mtimeNs,
        isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(),
      };
    },
  };
  const limited = await fullScan(f.config, {
    confirmReadOnly: true, generationId: "mtime-limit", mode: "incremental",
    platformId: "pixiv", authorDirectoryName: "100", io: maskedIo,
  });
  assert.equal(limited.changes.worksRebuilt, 0);
  const workDirectory = path.dirname(target);
  const oldDirectory = NODE_FS_IO.lstat(workDirectory);
  fs.writeFileSync(path.join(workDirectory, ".nocover"), "");
  const presentationIo = {
    ...maskedIo,
    lstat(file) {
      const stat = maskedIo.lstat(file);
      if (path.resolve(file) !== path.resolve(workDirectory)) return stat;
      return {
        size: oldDirectory.size, mtimeNs: oldDirectory.mtimeNs,
        isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(),
      };
    },
  };
  const presentation = await fullScan(f.config, {
    confirmReadOnly: true, generationId: "presentation-marker", mode: "incremental",
    platformId: "pixiv", authorDirectoryName: "100", io: presentationIo,
  });
  assert.equal(presentation.changes.worksRebuilt, 1);
  assert.equal(rows(active(f.config).catalogPath, "SELECT count(*) AS n FROM field_sources WHERE field='media.coverDisabled'")[0].n, 1n);
  const beforeFailure = fs.readFileSync(f.config.activeGenerationPath);
  const failingIo = {
    ...NODE_FS_IO,
    readdir(file) {
      if (path.basename(file) === "nested") throw Object.assign(new Error("synthetic unreadable"), { code: "EACCES" });
      return NODE_FS_IO.readdir(file);
    },
  };
  await assert.rejects(fullScan(f.config, {
    confirmReadOnly: true, generationId: "partial-failure", mode: "incremental",
    platformId: "pixiv", authorDirectoryName: "100", io: failingIo,
  }), { code: "GENERATION_CATALOG_INCOMPLETE" });
  assert.deepEqual(fs.readFileSync(f.config.activeGenerationPath), beforeFailure);
});

test("invalid scope is rejected before a candidate is created", async (t) => {
  const f = await fixture(t, { empty: true });
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  await assert.rejects(fullScan(f.config, { confirmReadOnly: true, mode: "incremental", authorDirectoryName: "100" }), { code: "SCAN_AUTHOR_PLATFORM_REQUIRED" });
  await assert.rejects(fullScan(f.config, { confirmReadOnly: true, mode: "delta" }), { code: "SCAN_MODE_INVALID" });
  await assert.rejects(fullScan(f.config, { confirmReadOnly: true, mode: "full", platformId: "pixiv" }), { code: "SCAN_BASELINE_REQUIRED" });
  await assert.rejects(
    fullScan(f.config, {
      confirmReadOnly: true,
      mode: "incremental",
      platformIds: [],
    }),
    { code: "SCAN_PLATFORM_INVALID" },
  );
  await assert.rejects(
    fullScan(f.config, {
      confirmReadOnly: true,
      mode: "incremental",
      platformIds: ["pixiv", "pixiv"],
    }),
    { code: "SCAN_PLATFORM_INVALID" },
  );
  await assert.rejects(
    fullScan(f.config, {
      confirmReadOnly: true,
      mode: "incremental",
      platformIds: ["pixiv", "Gank"],
      authorDirectoryName: "100",
    }),
    { code: "SCAN_AUTHOR_PLATFORM_REQUIRED" },
  );
});

test("older extraction versions remain readable baselines while current and future gates stay distinct", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.config.tempRoot, "legacy-contract.sqlite");
  await buildCatalog({ catalogPath: file, platformRoots: f.bindings });
  const db = new Database(file);
  let open = true;
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys=ON");
  const current = PLATFORM_REGISTRY.find((platform) => platform.id === "pixiv").adapterVersion;
  function refreshFingerprint() {
    const rowsById = new Map(db.prepare("SELECT * FROM platforms").all().map((row) => [row.platform_id, row]));
    const facts = PLATFORM_REGISTRY.map(({ id }) => rowsById.get(id)).map((row) => ({
      adapterVersion: Number(row.adapter_version), enabled: row.enabled === 1n, family: row.family,
      id: row.platform_id, physicalRoot: row.physical_root, physicalRootKey: row.physical_root_key,
    }));
    const fingerprint = crypto.createHash("sha256").update(stableJson(facts), "utf8").digest("hex");
    db.prepare("UPDATE catalog_state SET platform_registry_fingerprint=? WHERE singleton=1").run(fingerprint);
  }
  try {
    db.prepare("UPDATE platforms SET adapter_version=? WHERE platform_id='pixiv'").run(current - 1);
    db.prepare("UPDATE works SET adapter_version=? WHERE platform_id='pixiv'").run(current - 1);
    refreshFingerprint();
    assert.equal(verifyCatalogContract(db), true);
    assert.throws(() => verifyCatalogContract(db, { requireCurrentRegistry: true }), { code: "catalog_contract_stale_version" });
    db.prepare("UPDATE platforms SET adapter_version=? WHERE platform_id='pixiv'").run(current + 1);
    refreshFingerprint();
    assert.throws(() => verifyCatalogContract(db), { code: "catalog_contract_future_version" });
    db.prepare("UPDATE platforms SET adapter_version=? WHERE platform_id='pixiv'").run(current - 1);
    refreshFingerprint();
    db.close(); open = false;
    const refreshed = await updateCatalog({
      catalogPath: path.join(f.config.tempRoot, "refreshed-contract.sqlite"),
      baseCatalogPath: file, platformRoots: f.bindings, mode: "incremental",
      platformIds: ["Venera", "Gank"],
    });
    assert.ok(refreshed.report.scope.invalidatedPlatformIds.includes("pixiv"));
    assert.ok(refreshed.report.scope.effectivePlatformIds.includes("pixiv"));
    assert.deepEqual(refreshed.report.scope.requestedPlatformIds, ["Gank", "Venera"]);
    assert.deepEqual(refreshed.report.scope.effectivePlatformIds, ["pixiv", "Gank", "Venera"]);
    assert.equal(rows(refreshed.catalogPath, "SELECT count(*) AS n FROM works w JOIN platforms p USING(platform_id) WHERE w.adapter_version<>p.adapter_version")[0].n, 0n);
  } finally { if (open) db.close(); }
});

test("a concurrent active-pointer change wins and the stale candidate is not published", async (t) => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.config.tempRoot, "rimraf-prewarm"), { recursive: true, force: true });
  await f.build("race-base");
  f.publish("race-base");
  await f.build("race-winner");
  let switched = false;
  const io = {
    ...NODE_FS_IO,
    readdir(target) {
      if (!switched) { switched = true; f.publish("race-winner"); }
      return NODE_FS_IO.readdir(target);
    },
  };
  await assert.rejects(fullScan(f.config, {
    confirmReadOnly: true, generationId: "race-stale", mode: "incremental",
    platformId: "pixiv", authorDirectoryName: "100", io,
  }), { code: "SCAN_BASELINE_CHANGED" });
  assert.equal(active(f.config).generationId, "race-winner");
});
});
