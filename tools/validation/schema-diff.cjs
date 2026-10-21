"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../.."),
  reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { prepare } = require("./prepare.cjs"),
  { freePort } = require("../../test/support/runtime.js");
const Database = require(path.join(reference, "node_modules/better-sqlite3")),
  contract = require("../../api/catalog.json");
async function main() {
  const root =
      process.env.GALLERY_TEST_ROOT || path.join(os.tmpdir(), "Gallery-Legacy"),
    out = path.join(root, "Schema-" + Date.now());
  const demo = await prepare(path.join(out, "Node"), {
    port: await freePort(),
  });
  const legacy = require(path.join(reference, "src/instance/config.js"));
  const referenceConfig = legacy.normalizeRuntimeConfig({
    instanceRoot: path.join(out, "NodeReference"),
    sources: demo.config.sources,
    liveUpdates: true,
    port: await freePort(),
  });
  legacy.ensureLayout(referenceConfig);
  await require(path.join(reference, "src/catalog/live.js")).ensureLive(
    referenceConfig,
    null,
  );
  const db = new Database(
    path.join(referenceConfig.instanceRoot, "live/catalog.sqlite"),
    { readonly: true },
  );
  const tables = [
    ...contract.tables,
    "live_meta",
    "live_id_high_water",
    "live_stats",
    "live_metadata_stats",
    "live_platform_stats",
    "live_scan_works",
    "live_scan_authors",
    "live_work_sort",
    "live_search_docs",
    "live_work_tags",
    "live_authors",
    "live_tags",
  ];
  let expected;
  try {
    expected = {
      objects: db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all()
        .map((r) => ({
          ...r,
          sql: r.sql?.replace(/\s+/g, " ").trim() ?? null,
        })),
    };
    for (const table of tables) {
      expected[table] = db.prepare("SELECT * FROM " + table).all();
      for (const row of expected[table]) {
        if (table === "catalog_state") delete row.built_at_ms;
        if (table === "live_meta") {
          delete row.epoch;
          delete row.initialized_at_ms;
        }
      }
    }
  } finally {
    db.close();
  }
  const checks = [];
  const verify = require(
    path.join(reference, "src/catalog/writer.js"),
  ).verifyCatalogContract;
  const definitions = [
    ["valid live", [], { allowLive: true }],
    ["live requires explicit mode", [], {}],
    [
      "contract version changed",
      ["UPDATE catalog_state SET adapter_contract_version=99"],
      { allowLive: true },
    ],
    [
      "normalizer contract changed",
      ["UPDATE catalog_state SET normalizer_version=1"],
      { allowLive: true },
    ],
    [
      "fingerprint changed",
      [
        "UPDATE catalog_state SET platform_registry_fingerprint='" +
          "0".repeat(64) +
          "'",
      ],
      { allowLive: true },
    ],
    ["live core missing", ["DROP TABLE live_work_sort"], { allowLive: true }],
    ["live stats missing", ["DROP TABLE live_stats"], { allowLive: true }],
    ["ledger missing", ["DROP TABLE live_scan_works"], { allowLive: true }],
    [
      "index missing",
      ["DROP INDEX live_idx_relation_target_all"],
      { allowLive: true },
    ],
    [
      "unexpected live table",
      ["CREATE TABLE live_unknown(value TEXT)"],
      { allowLive: true },
    ],
    [
      "unexpected live trigger",
      ["CREATE TRIGGER live_unknown AFTER INSERT ON works BEGIN SELECT 1; END"],
      { allowLive: true },
    ],
    [
      "legacy permits missing stats",
      ["DROP TABLE live_stats"],
      { allowLive: true, allowLegacyLive: true },
    ],
    [
      "source binding changed",
      [],
      {
        allowLive: true,
        sources: { ...demo.config.sources, pixiv: path.join(out, "Different") },
      },
    ],
  ];
  for (const [name, statements, options] of definitions) {
    const target = path.join(out, "check-" + checks.length + ".sqlite");
    const source = new Database(
      path.join(referenceConfig.instanceRoot, "live/catalog.sqlite"),
      { readonly: true },
    );
    try {
      await source.backup(target);
    } finally {
      source.close();
    }
    const mutated = new Database(target);
    mutated.defaultSafeIntegers(true);
    mutated.pragma("foreign_keys=ON");
    let code = null;
    try {
      for (const sql of statements) mutated.exec(sql);
      verify(mutated, options);
      if (options.sources)
        for (const row of mutated
          .prepare("SELECT platform_id,physical_root_key FROM platforms")
          .all()) {
          if (
            require(
              path.join(reference, "src/library/platforms.js"),
            ).normalizePhysicalRootKey(options.sources[row.platform_id]) !==
            row.physical_root_key
          )
            throw Object.assign(Error("binding"), {
              code: "SOURCE_BINDING_MISMATCH",
            });
        }
    } catch (error) {
      code = error.code || error.message;
    } finally {
      mutated.close();
    }
    checks.push({ name, file: target, options, code });
  }
  const golden = path.join(out, "node-golden.json");
  fs.writeFileSync(
    golden,
    JSON.stringify(
      {
        instanceRoot: path.join(out, "Go"),
        sources: demo.config.sources,
        tables,
        expected,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "tools/go/run.cjs"),
      "test",
      ...(process.argv.includes("--race") ? ["-race"] : []),
      "-count=1",
      "-run",
      "CreateLiveNode|PublishNewCatalog",
      "./internal/catalog/...",
    ],
    {
      cwd: repo,
      env: { ...process.env, GALLERY_SCHEMA_GOLDEN: golden },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(out, "go-test.log"),
    (result.stdout || "") + (result.stderr || ""),
  );
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        reference,
        exitCode: result.status,
        conclusion: result.status === 0 ? "一致" : "有差异",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ output: out, exitCode: result.status }));
  process.exitCode = result.status === 0 ? 0 : 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
