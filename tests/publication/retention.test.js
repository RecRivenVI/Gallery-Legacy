"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { fixture } = require("../support/runtime.js");
const { retentionPlan, retainGenerations } = require("../../internal/publication/retention.js");
const { writeJson } = require("../../internal/instance/files.js");
test("retention protects active, loaded, previous READY and live building candidate", async (t) => {
  const f = await fixture(t, { empty: true });
  for (const id of ["old", "loaded", "previous", "active"]) { await f.build(id); f.publish(id); }
  const identity = { pid: 100, start: "test", exe: "synthetic" };
  writeJson(path.join(f.config.stateRoot, "runtime.lock"), { identity });
  writeJson(f.config.statusPath, { loadedGenerationId: "loaded" });
  writeJson(path.join(f.config.stateRoot, "scan.lock"), { identity });
  writeJson(f.config.scanStatusPath, { generationId: "building", running: true });
  writeJson(path.join(f.config.generationsRoot, "building", "manifest.json"), { generationId: "building", state: "BUILDING", createdAtMs: 1 });
  const plan = retentionPlan(f.config, { identify: () => identity, nowMs: Date.now() + 172800000 });
  assert.deepEqual(plan.filter((e) => e.action === "DELETE").map((e) => e.id), ["old"]);
  const unknown = retentionPlan(f.config, { identify: () => { throw new Error("denied"); }, nowMs: Date.now() + 172800000 });
  assert.ok(unknown.every((e) => e.action === "RETAIN"));
});
test("dead candidate recovery removes only unreferenced expired generations under lease", async (t) => {
  const f = await fixture(t, { empty: true });
  for (const id of ["old", "previous", "active"]) { await f.build(id); f.publish(id); }
  writeJson(path.join(f.config.generationsRoot, "abandoned", "manifest.json"), { generationId: "abandoned", state: "BUILDING", createdAtMs: 1 });
  writeJson(path.join(f.config.generationsRoot, "unknown", "manifest.json"), { state: "broken" });
  const report = await retainGenerations(f.config, { nowMs: Date.now() + 172800000 });
  assert.deepEqual(report.removed.map((e) => e.id), ["abandoned", "old"]);
  assert.ok(report.bytes > 0);
  assert.ok(fs.existsSync(path.join(f.config.generationsRoot, "active")));
  assert.ok(fs.existsSync(path.join(f.config.generationsRoot, "previous")));
  assert.ok(fs.existsSync(path.join(f.config.generationsRoot, "unknown")));
});
