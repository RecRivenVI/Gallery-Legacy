"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), cp = require("node:child_process");
const { fixture } = require("../support/runtime.js");
const { writeJson } = require("../../internal/instance/files.js");
const { operation } = require("../../internal/runtime/validation.js");
const { manage } = require("../../internal/runtime/management.js");
for (const kind of ["validation", "scan"]) test(`${kind} completion during owner lookup is not misreported as a crashed task`, async t => {
  const f = await fixture(t, { empty: true });
  const file = kind === "scan" ? f.config.scanStatusPath : path.join(f.config.stateRoot, "validation.json");
  const initial = { id: "synthetic-task", generationId: "synthetic-generation", pid: process.pid, identity: { pid: process.pid, start: "before", exe: "synthetic" }, state: "RUNNING", running: true };
  const terminal = { ...initial, state: kind === "scan" ? "READY" : "COMPLETED", running: false };
  writeJson(file, initial);
  let completes = true;
  t.mock.method(cp, "execFileSync", () => { if (completes) writeJson(file, terminal); return JSON.stringify({ pid: process.pid, start: "after", exe: "synthetic" }); });
  const read = () => kind === "scan" ? manage(path.join(f.config.instanceRoot, "config.json"), "scan.status") : operation(f.config, "", "validation.status");
  const result = await read(); assert.equal(result.state, terminal.state); assert.equal(result.running, false);
  completes = false; writeJson(file, initial);
  const failed = await read(); assert.equal(failed.state, "FAILED"); assert.equal(failed.failure?.code || failed.error, kind === "scan" ? "SCAN_OWNER_EXITED" : "VALIDATION_OWNER_EXITED");
});
