import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openManager } from "./manager-driver.mjs";
const require = createRequire(import.meta.url);
const {
  GALLERY_TEST_ROOT: root,
  GALLERY_NODE_REFERENCE_ROOT: reference,
  GALLERY_LIFECYCLE_EVIDENCE: out,
} = process.env;
if (!root || !reference || !out)
  throw Error("Explicit synthetic bindings required");
process.env.GALLERY_ASSETS_ROOT = path.join(reference, "resources");
const prior = JSON.parse(
  fs.readFileSync(path.join(out, "lifecycle-minimal.json")),
);
const sources = JSON.parse(
  fs.readFileSync(path.join(prior.input, "Input/instance/config.json")),
).sources;
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const { manage } = require(path.join(reference, "src/runtime/management.js"));
const { freePort } = require("../../test/support/runtime.js");
const observations = [];
for (const kind of ["Node", "Go"]) {
  const instanceRoot = fs.mkdtempSync(path.join(root, `Manage-${kind}-`));
  const raw = {
    instanceRoot,
    sources,
    liveUpdates: true,
    port: await freePort(),
    retention: { enabled: true, staleAfterMs: 86400000 },
  };
  const c = normalizeRuntimeConfig(raw);
  ensureLayout(c);
  const file = path.join(instanceRoot, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  let manager;
  try {
    if (kind === "Go") manager = await openManager(c, file);
    const call = (op, input = {}) =>
      kind === "Node"
        ? manage(file, op, input)
        : manager.call("manage", op, input);
    const before = await call("config.read");
    assert.deepEqual(before.value, raw);
    const valid = await call("config.validate", { value: raw });
    await assert.rejects(
      call("config.save", { confirm: true, value: raw, revision: "wrong" }),
      (e) => e.code === "CONFIG_REVISION_CHANGED",
    );
    const saved = await call("config.save", {
      confirm: true,
      value: raw,
      revision: before.revision,
    });
    assert.deepEqual(saved.value, raw);
    const backup = await call("config.backup.read", { name: saved.backup });
    assert.deepEqual(backup.value, raw);
    assert.equal((await call("config.backups")).items.length, 1);
    const authors = await call("scope.authors", {
      platformId: "pixiv",
      query: "",
      page: 1,
    });
    const scope = await call("scope.check", {
      platformId: "pixiv",
      confirmReadOnly: true,
    });
    delete scope.report;
    const cache = path.join(c.cacheRoot, "thumbnails", "aa");
    fs.mkdirSync(cache, { recursive: true });
    const present = path.join(
      sources.pixiv,
      "700",
      "2026-01-01_00-00-00_duplicate",
      "1.png",
    );
    for (const [number, source] of [
      [1, present],
      [2, path.join(sources.pixiv, "not-present.png")],
      [3, null],
    ]) {
      const image = path.join(
        cache,
        String(number).padStart(64, "a") + ".webp",
      );
      fs.writeFileSync(image, "synthetic thumbnail");
      fs.writeFileSync(
        image + ".json",
        JSON.stringify(source ? { version: 1, source } : { version: 99 }),
      );
    }
    const orphans = await call("cache.orphans");
    assert.equal(orphans.orphanFiles, 1);
    assert.equal(orphans.unknown, 1);
    const manifests = [
      { generationId: "current", state: "READY", createdAtMs: 3000 },
      { generationId: "previous", state: "READY", createdAtMs: 2000 },
      { generationId: "old", state: "FAILED", createdAtMs: 1 },
      { generationId: "unknown", state: "FUTURE", createdAtMs: 1 },
      { generationId: "undated", state: "FAILED" },
    ];
    for (const m of manifests) {
      const d = path.join(c.generationsRoot, m.generationId);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(m));
    }
    fs.writeFileSync(
      c.activeGenerationPath,
      JSON.stringify({ generationId: "current" }),
    );
    const plan = await call("retention.plan");
    assert.equal(plan.items.find((x) => x.id === "old").action, "DELETE");
    assert.equal(plan.items.find((x) => x.id === "unknown").action, "RETAIN");
    assert.equal(plan.items.find((x) => x.id === "undated").reason, "recent");
    observations.push({ kind, valid, authors, scope, orphans, plan });
    if (kind === "Go") {
      const removed = await call("cache.orphans.clear", { confirm: true });
      assert.equal(removed.removed, 1);
      const retained = await call("retention.apply", { confirm: true });
      assert.deepEqual(
        retained.removed.map((x) => x.id),
        ["old"],
      );
      assert(fs.existsSync(path.join(c.generationsRoot, "unknown")));
      await assert.rejects(
        call("config.read", []),
        (e) => e.code === "MANAGEMENT_INPUT_INVALID",
      );
    }
  } finally {
    if (manager) await manager.close();
  }
}
// The old bridge serializes its result; undefined properties are not on wire.
assert.deepEqual(
  JSON.parse(JSON.stringify({ ...observations[0], kind: null })),
  JSON.parse(JSON.stringify({ ...observations[1], kind: null })),
);
fs.writeFileSync(
  path.join(out, "management-diff.json"),
  JSON.stringify({ conclusion: "一致", observations }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    conclusion: "一致",
    scope:
      "config, authors, scope, orphan plan and retention plan; Go recoverable apply",
  }),
);
