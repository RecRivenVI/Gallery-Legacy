"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../.."),
  reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { prepare } = require("./prepare.cjs"),
  { freePort } = require("../../test/support/runtime.js");
const Database = require(path.join(reference, "node_modules/better-sqlite3"));
const generations = require(
  path.join(reference, "src/publication/generations.js"),
);
const validate = require(
  path.join(reference, "src/catalog/validation.js"),
).validateCatalog;
const live = require(path.join(reference, "src/catalog/live.js"));
const files = require(path.join(reference, "src/instance/config.js"));
async function main() {
  const out = path.join(
    process.env.GALLERY_TEST_ROOT || path.join(os.tmpdir(), "Gallery-Legacy"),
    "Recovery-" + Date.now(),
  );
  const demo = await prepare(path.join(out, "Input"), {
    port: await freePort(),
  });
  const frozen = await generations.buildGeneration({
    instanceRoot: demo.config.instanceRoot,
    generationId: "first",
    catalogOptions: { platformRoots: demo.config.sources },
  });
  generations.publishGeneration(demo.config.instanceRoot, "first");
  const cases = [];
  function result(fn) {
    try {
      return { value: fn(), code: null };
    } catch (e) {
      return { value: null, code: e.code || e.message };
    }
  }
  function checkpoint(name, instance, operation = "open") {
    const actual = result(() =>
      operation === "active"
        ? generations.resolveActiveGeneration(instance)
        : generations.validateGeneration(
            path.join(instance, "generations/first"),
            { instanceRoot: instance },
          ),
    );
    cases.push({
      name,
      operation,
      instance,
      code: actual.code,
      expected: actual.value
        ? {
            generationId: actual.value.generationId,
            facts: catalogFacts(actual.value.catalogPath),
          }
        : null,
    });
  }
  function catalogFacts(file) {
    const db = new Database(file, { readonly: true });
    db.defaultSafeIntegers(true);
    try {
      return validate(db);
    } finally {
      db.close();
    }
  }
  checkpoint("valid READY", demo.config.instanceRoot);
  checkpoint("valid pointer", demo.config.instanceRoot, "active");
  const definitions = [
    ["BUILDING", (m) => (m.state = "BUILDING")],
    ["manifest version", (m) => (m.manifestVersion = 99)],
    ["generation identity", (m) => (m.generationId = "other")],
    ["path escape", (m) => (m.catalog.relativePath = "../catalog.sqlite")],
    ["catalog version", (m) => (m.catalog.schemaVersion = 99)],
    ["search version", (m) => (m.search.indexVersion = 99)],
    ["not finalized", (m) => delete m.finalization],
    ["sidecar proof missing", (m) => delete m.finalization.search.sidecars],
    ["validation missing", (m) => (m.validation.catalog = "failed")],
    ["hash changed", (m) => (m.catalog.sha256 = "0".repeat(64))],
    ["work count changed", (m) => m.catalog.workCount++],
    ["search count changed", (m) => m.search.catalogWorkCount++],
    ["search size changed", (m) => m.search.catalogSizeBytes++],
    ["string manifest version", (m) => (m.manifestVersion = "1")],
    ["string catalog version", (m) => (m.catalog.schemaVersion = "4")],
    ["string search version", (m) => (m.search.indexVersion = "5")],
    [
      "string identity time",
      (m) => (m.catalog.mtimeMs = String(m.catalog.mtimeMs)),
    ],
    [
      "string work count",
      (m) => (m.catalog.workCount = String(m.catalog.workCount)),
    ],
    ["string sidecar proof", (m) => (m.finalization.search.sidecars = "false")],
    ["null validation", (m) => (m.validation = null)],
    ["null catalog", (m) => (m.catalog = null)],
  ];
  for (const [name, mutate] of definitions) {
    const instance = path.join(out, "Checkpoint-" + cases.length);
    fs.cpSync(
      path.join(demo.config.instanceRoot, "generations"),
      path.join(instance, "generations"),
      { recursive: true, preserveTimestamps: true },
    );
    const file = path.join(instance, "generations/first/manifest.json"),
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(manifest);
    fs.writeFileSync(file, JSON.stringify(manifest));
    checkpoint(name, instance);
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const instance = path.join(out, "Sidecar-" + cases.length);
    fs.cpSync(
      path.join(demo.config.instanceRoot, "generations"),
      path.join(instance, "generations"),
      { recursive: true, preserveTimestamps: true },
    );
    fs.writeFileSync(
      path.join(instance, "generations/first/catalog/gallery-v4.sqlite") +
        suffix,
      "",
    );
    checkpoint("residual " + suffix, instance);
  }
  for (const name of ["catalog", "search", "json"]) {
    const instance = path.join(out, "Missing-" + cases.length);
    fs.cpSync(
      path.join(demo.config.instanceRoot, "generations"),
      path.join(instance, "generations"),
      { recursive: true, preserveTimestamps: true },
    );
    if (name === "json")
      fs.writeFileSync(
        path.join(instance, "generations/first/manifest.json"),
        "{broken",
      );
    else {
      const target = path.join(
        instance,
        "generations/first",
        name === "catalog"
          ? "catalog/gallery-v4.sqlite"
          : "search/gallery-search.sqlite",
      );
      fs.renameSync(target, target + ".missing");
    }
    checkpoint(
      name === "json" ? "malformed JSON" : "missing " + name,
      instance,
    );
  }
  for (const [name, pointer] of [
    [
      "pointer version",
      {
        pointerVersion: 2,
        generationId: "first",
        manifestPath: "generations/first/manifest.json",
      },
    ],
    [
      "pointer escape",
      {
        pointerVersion: 1,
        generationId: "first",
        manifestPath: "../manifest.json",
      },
    ],
    [
      "string pointer version",
      {
        pointerVersion: "1",
        generationId: "first",
        manifestPath: "generations/first/manifest.json",
      },
    ],
  ]) {
    const instance = path.join(out, "Pointer-" + cases.length);
    fs.mkdirSync(instance, { recursive: true });
    fs.writeFileSync(
      path.join(instance, "active-generation.json"),
      JSON.stringify(pointer),
    );
    checkpoint(name, instance, "active");
  }
  const validations = [];
  for (const [name, sql] of [
    ["valid", null],
    ["author counts", "UPDATE authors SET work_count=work_count+1"],
    ["tag counts", "UPDATE tags SET work_count=work_count+1"],
    ["shape counts", "UPDATE metadata_shapes SET work_count=work_count+1"],
    ["media counts", "UPDATE works SET image_count=image_count+1"],
    [
      "foreign key",
      "UPDATE media SET work_id=9223372036854775807 WHERE media_id=(SELECT min(media_id) FROM media)",
    ],
    ["path escape", "UPDATE works SET relative_path='../escape'"],
    [
      "source provenance",
      "UPDATE works SET source_work_id=NULL WHERE source_work_id IS NOT NULL",
    ],
  ]) {
    const file = path.join(out, "validation-" + validations.length + ".sqlite");
    fs.copyFileSync(frozen.catalogPath, file);
    const db = new Database(file);
    db.defaultSafeIntegers(true);
    db.pragma("foreign_keys=OFF");
    try {
      if (sql) db.exec(sql);
      db.pragma("foreign_keys=ON");
      const actual = result(() => validate(db));
      validations.push({
        name,
        file,
        expected: actual.value,
        code: actual.code,
      });
    } finally {
      db.close();
    }
  }
  const restores = [];
  for (const legacy of [null, 1, 2]) {
    const instance = path.join(out, "NodeRestore-" + (legacy || "new"));
    const config = files.normalizeRuntimeConfig({
      instanceRoot: instance,
      sources: demo.config.sources,
      liveUpdates: true,
      port: await freePort(),
    });
    files.ensureLayout(config);
    await live.ensureLive(config, frozen);
    const target = path.join(instance, "live/catalog.sqlite");
    if (legacy) {
      const db = new Database(target);
      try {
        db.exec("DROP TABLE live_scan_works; DROP TABLE live_scan_authors;");
        if (legacy === 1)
          db.exec(
            "DROP TABLE live_stats; DROP TABLE live_metadata_stats; DROP TABLE live_platform_stats;",
          );
        db.prepare("UPDATE live_meta SET schema_version=?").run(legacy);
      } finally {
        db.close();
      }
    }
    const input = path.join(out, "GoRestore-" + (legacy || "new"));
    fs.mkdirSync(path.join(input, "live"), { recursive: true });
    if (legacy)
      fs.copyFileSync(target, path.join(input, "live/catalog.sqlite"));
    await live.ensureLive(config, frozen);
    const db = new Database(target);
    db.defaultSafeIntegers(true);
    const tables = [
      "live_meta",
      "live_id_high_water",
      "live_stats",
      "live_metadata_stats",
      "live_platform_stats",
      "live_work_sort",
      "live_search_docs",
      "live_work_tags",
      "live_authors",
      "live_tags",
      "live_scan_works",
      "live_scan_authors",
    ];
    try {
      const expected = {};
      for (const table of tables)
        expected[table] = db
          .prepare("SELECT * FROM " + table)
          .all()
          .map((r) => {
            if (table === "live_meta") {
              delete r.epoch;
              delete r.initialized_at_ms;
            }
            return r;
          });
      restores.push({
        name: "restore " + (legacy || "new"),
        legacy,
        instance: input,
        base: frozen.catalogPath,
        generationId: frozen.generationId,
        sources: demo.config.sources,
        expected,
        tables,
      });
    } finally {
      db.close();
    }
  }
  const golden = path.join(out, "node-golden.json");
  fs.writeFileSync(
    golden,
    JSON.stringify(
      { cases, validations, restores },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  const run = spawnSync(
    process.execPath,
    [
      path.join(repo, "tools/go/run.cjs"),
      "test",
      ...(process.argv.includes("--race") ? ["-race"] : []),
      "-count=1",
      "./internal/recovery/...",
    ],
    {
      cwd: repo,
      env: { ...process.env, GALLERY_RECOVERY_GOLDEN: golden },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(out, "go-test.log"),
    (run.stdout || "") + (run.stderr || ""),
  );
  const summary = {
    output: out,
    cases: cases.length,
    validations: validations.length,
    restores: restores.length,
    exitCode: run.status,
    conclusion: run.status === 0 ? "一致" : "有差异",
  };
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  process.exitCode = run.status === 0 ? 0 : 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
