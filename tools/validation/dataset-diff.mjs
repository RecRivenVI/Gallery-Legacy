import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../.."),
  reference = process.env.GALLERY_NODE_REFERENCE_ROOT || repo;
const { prepare } = require("./prepare.cjs"),
  { freePort } = require("../../test/support/runtime.js");
const cfg = require(path.join(reference, "src/instance/config.js"));
const generations = require(
  path.join(reference, "src/publication/generations.js"),
);
const live = require(path.join(reference, "src/catalog/live.js"));
const { openDataset } = require(path.join(reference, "src/server/dataset.js"));
const { query, encodeCursor } = require(
  path.join(reference, "src/server/input.js"),
);
const Database = require(path.join(reference, "node_modules/better-sqlite3"));
async function main() {
  const out = fs.mkdtempSync(
    path.join(process.env.GALLERY_TEST_ROOT || os.tmpdir(), "Dataset-"),
  );
  const demo = await prepare(path.join(out, "Input"), {
    port: await freePort(),
  });
  const frozen = await generations.buildGeneration({
    instanceRoot: demo.config.instanceRoot,
    generationId: "first",
    catalogOptions: { platformRoots: demo.config.sources },
  });
  const cases = [];
  async function input(name, options = {}) {
    const root = path.join(out, name),
      raw = {
        instanceRoot: root,
        sources: demo.config.sources,
        liveUpdates: options.live === true,
        port: 18104,
      };
    fs.mkdirSync(root, { recursive: true });
    if (options.generation) {
      fs.cpSync(frozen.generationRoot, path.join(root, "generations/first"), {
        recursive: true,
        preserveTimestamps: true,
      });
      generations.publishGeneration(root, "first");
    }
    const config = cfg.normalizeRuntimeConfig(raw);
    cfg.ensureLayout(config);
    const generation = options.generation
      ? generations.resolveActiveGeneration(root)
      : null;
    if (options.prepare) await live.ensureLive(config, generation);
    if (options.mutate) await options.mutate(raw, config);
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, JSON.stringify(raw));
    let data;
    try {
      let active = null;
      if (fs.existsSync(config.activeGenerationPath))
        active = generations.resolveActiveGeneration(root);
      data = openDataset(cfg.normalizeRuntimeConfig(raw), active);
      const state = {
        libraryReady: !!data.generation || !!data.live,
        counts: data.reader.stats(),
        platformStats: data.reader.platformStats(),
        ...(data.live ? { live: data.liveState() } : {}),
      };
      const pages = [];
      for (const kind of ["works", "authors", "tags"]) {
        for (const rawQuery of [
          "pageSize=2",
          "q=missing-synthetic-result",
          "platformId=pixiv&pageSize=2",
          "page=0",
        ]) {
          try {
            const params = new URLSearchParams(rawQuery),
              q = query(
                params,
                kind,
                data.epoch,
                data.liveState()?.revision ?? null,
              );
            q.offset = q.cursor ? 0 : (q.page - 1) * q.pageSize;
            const r =
              kind === "works"
                ? data.index.workPage(q)
                : kind === "authors"
                  ? data.index.authorPage(q)
                  : data.index.tagPage(q);
            const items =
              kind === "works"
                ? data.reader.works(
                    r.rows.map((x) => x.work_id),
                    q.mediaType,
                  )
                : kind === "authors"
                  ? data.reader.authors(r.rows.map((x) => x.author_id))
                  : r.rows.map((x) => ({
                      id: String(x.tag_id),
                      label: x.display_value,
                      workCount: Number(x.work_count),
                    }));
            pages.push({
              kind,
              raw: rawQuery,
              expected: {
                items,
                total: r.total,
                page: q.page,
                pageSize: q.pageSize,
                totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)),
                cursor: encodeCursor(r.nextCursor, q.key, q.revision),
                ...(data.live ? { revision: q.revision } : {}),
                mode: r.mode || kind,
              },
            });
          } catch (e) {
            pages.push({ kind, raw: rawQuery, code: e.code || e.message });
          }
        }
      }
      cases.push({ name, file, epoch: data.epoch, state, pages });
    } catch (e) {
      cases.push({ name, file, code: e.code || e.message });
    } finally {
      await data?.close();
    }
  }
  await input("Empty");
  await input("Static", { generation: true });
  await input("LiveEmpty", { live: true, prepare: true });
  await input("LiveRecovered", { live: true, generation: true, prepare: true });
  await input("LiveNotPrepared", { live: true });
  for (const isLive of [false, true])
    await input("BindingMismatch-" + isLive, {
      generation: true,
      live: isLive,
      prepare: isLive,
      mutate(raw) {
        raw.sources = { ...raw.sources, pixiv: path.join(out, "OtherPixiv") };
      },
    });
  await input("BrokenPointer", {
    mutate(raw, config) {
      fs.writeFileSync(config.activeGenerationPath, "{broken");
    },
  });
  await input("Building", {
    generation: true,
    mutate(raw, config) {
      const file = path.join(config.generationsRoot, "first/manifest.json"),
        m = JSON.parse(fs.readFileSync(file));
      m.state = "BUILDING";
      fs.writeFileSync(file, JSON.stringify(m));
    },
  });
  await input("InvalidLiveEpoch", {
    live: true,
    prepare: true,
    mutate(raw, config) {
      const db = new Database(
        path.join(config.instanceRoot, "live/catalog.sqlite"),
      );
      try {
        db.exec("UPDATE live_meta SET epoch='bad'");
      } finally {
        db.close();
      }
    },
  });
  await input("BaseMismatch", {
    generation: true,
    live: true,
    prepare: true,
    mutate(raw, config) {
      const db = new Database(
        path.join(config.instanceRoot, "live/catalog.sqlite"),
      );
      try {
        db.exec("UPDATE live_meta SET base_generation_id='other'");
      } finally {
        db.close();
      }
    },
  });
  const golden = path.join(out, "golden.json");
  fs.writeFileSync(
    golden,
    JSON.stringify(
      {
        cases,
        configFile:
          demo.configFile || path.join(demo.config.instanceRoot, "config.json"),
        base: frozen.catalogPath,
        generationId: frozen.generationId,
      },
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
      "./internal/dataset/...",
      "-v",
    ],
    {
      cwd: repo,
      env: { ...process.env, GALLERY_DATASET_GOLDEN: golden },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  fs.writeFileSync(
    path.join(out, "go-test.log"),
    (run.stdout || "") + (run.stderr || ""),
  );
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        conclusion: run.status === 0 ? "一致" : "有差异",
        reference,
        instances: cases.length,
        pageCases: cases.reduce((n, c) => n + (c.pages?.length || 0), 0),
        exitCode: run.status,
      },
      null,
      2,
    ),
  );
  process.stdout.write((run.stdout || "") + (run.stderr || ""));
  console.log(out);
  process.exitCode = run.status ?? 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
