import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openManager } from "./manager-driver.mjs";
const require = createRequire(import.meta.url);
const {
  GALLERY_TEST_ROOT: root,
  GALLERY_NODE_REFERENCE_ROOT: reference,
  GALLERY_LIFECYCLE_EVIDENCE: output,
} = process.env;
if (!root || !reference || !output)
  throw Error("explicit synthetic bindings required");
process.env.GALLERY_ASSETS_ROOT = path.join(reference, "resources");
const prior = JSON.parse(
  fs.readFileSync(path.join(output, "lifecycle-minimal.json")),
);
const sources = JSON.parse(
  fs.readFileSync(path.join(prior.input, "Input/instance/config.json")),
).sources;
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const validation = require(path.join(reference, "src/runtime/validation.js"));
const { freePort } = require("../../test/support/runtime.js");
const observations = [];
for (const kind of ["Node", "Go"]) {
  const instanceRoot = fs.mkdtempSync(path.join(root, `Inspect-${kind}-`));
  const raw = {
    instanceRoot,
    sources,
    liveUpdates: true,
    port: await freePort(),
    retention: { enabled: false },
  };
  const c = normalizeRuntimeConfig(raw);
  ensureLayout(c);
  const file = path.join(instanceRoot, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  let manager;
  try {
    let state;
    if (kind === "Node")
      state = await validation.runValidation(c, { confirmReadOnly: true });
    else {
      manager = await openManager(c, file);
      await manager.call("manage", "validation.start", {
        confirmReadOnly: true,
      });
      do {
        state = await manager.call("manage", "validation.status");
        if (state.running) await new Promise((r) => setTimeout(r, 50));
      } while (state.running);
    }
    assert.equal(state.state, "COMPLETED", JSON.stringify(state));
    const findings = fs
      .readFileSync(
        path.join(c.reportsRoot, state.id + ".findings.jsonl"),
        "utf8",
      )
      .trim()
      .split(/\r?\n/)
      .map((x) => {
        const { index, ...r } = JSON.parse(x);
        return r;
      })
      .sort((a, b) =>
        (a.platformId + "\0" + a.relativePath + "\0" + a.code).localeCompare(
          b.platformId + "\0" + b.relativePath + "\0" + b.code,
        ),
      );
    const summary = {
      works: state.works,
      authors: state.authors,
      total: state.total,
      counts: state.counts,
      findings,
    };
    if (kind === "Go") {
      const list = await manager.call("manage", "validation.findings", {
        id: state.id,
        limit: 200,
      });
      assert.equal(list.total, state.total);
      const exported = await manager.call("manage", "validation.export", {
        id: state.id,
      });
      assert.equal(exported.count, state.total);
      const first = list.items[0];
      const location = await manager.call("manage", "validation.location", {
        id: state.id,
        index: first.index,
      });
      assert(location.path.startsWith(sources[first.platformId]));
      await assert.rejects(
        manager.call("manage", "validation.start", {}),
        (e) => e.code === "READ_ONLY_CONFIRMATION_REQUIRED",
      );
    }
    observations.push({ kind, summary });
  } finally {
    if (manager) await manager.close();
  }
}
assert.deepEqual(observations[1].summary, observations[0].summary);
fs.writeFileSync(
  path.join(output, "inspection-diff.json"),
  JSON.stringify({ conclusion: "一致", observations }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    conclusion: "一致",
    works: observations[0].summary.works,
    total: observations[0].summary.total,
  }),
);
