import fs from "node:fs";
import path from "node:path";
import { openManager } from "./manager-driver.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const {
  GALLERY_TEST_ROOT: root,
  GALLERY_NODE_REFERENCE_ROOT: reference,
  GALLERY_RUNTIME_EXE: exe,
  GALLERY_LIFECYCLE_EVIDENCE: output,
} = process.env;
if (!root || !reference || !exe || !output)
  throw Error("Explicit synthetic bindings required");
const baseline = JSON.parse(
  fs.readFileSync(path.join(output, "lifecycle-minimal.json")),
);
const sources = JSON.parse(
  fs.readFileSync(path.join(baseline.input, "Input/instance/config.json")),
).sources;
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const { freePort } = require("../../test/support/runtime.js");
const ownership = require(path.join(reference, "src/instance/ownership.js"));
const control = require(path.join(reference, "src/runtime/control.js"));
const instanceRoot = fs.mkdtempSync(path.join(root, "Bound-"));
const raw = {
  instanceRoot,
  sources,
  port: await freePort(),
  liveUpdates: true,
  retention: { enabled: false },
};
const c = normalizeRuntimeConfig(raw);
ensureLayout(c);
const file = path.join(instanceRoot, "config.json");
fs.writeFileSync(file, JSON.stringify(raw));
process.env.GALLERY_ASSETS_ROOT = path.join(reference, "resources");
const refusals = {};
for (const op of ["serve", "start", "restart", "scan", "manager", "manage"]) {
  const r = spawnSync(exe, [op, "--config", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(r.status, 0);
  assert.equal(r.stderr.trim(), "MANAGER_REQUIRED");
  refusals[op] = r.stderr.trim();
}
const open = () => openManager(c, file);
let manager = await open();
try {
  const first = await manager.call("start");
  assert.equal(first.state, "READY");
  assert.equal((await manager.call("start")).pid, first.pid);
  assert.equal(
    (await control.control(c, "status")).managerPid,
    manager.child.pid,
  );
  await assert.rejects(
    control.control(c, "scan", { confirmReadOnly: true }),
    /MANAGER_REQUIRED/,
  );
  const scan = await manager.call("manage", "scan.start", {
    confirmReadOnly: true,
  });
  assert(scan.started);
  let state;
  do {
    state = await manager.call("manage", "scan.status");
    if (state.running) await new Promise((r) => setTimeout(r, 50));
  } while (state.running);
  assert.equal(state.state, "READY");
  assert.equal(state.counts.worksCommitted, 71);
  const status = await manager.call("status");
  assert.equal(status.counts.media, 284);
  await manager.call("manage", "scan.start", {
    confirmReadOnly: true,
    mode: "incremental",
    platformId: "pixiv",
    authorDirectoryName: "700",
  });
  let incremental;
  do {
    incremental = await manager.call("manage", "scan.status");
    if (incremental.running) await new Promise((r) => setTimeout(r, 50));
  } while (incremental.running);
  assert.equal(incremental.state, "READY", JSON.stringify(incremental));
  assert(incremental.counts.worksReused > 0);
  assert.equal((await manager.call("status")).counts.works, 71);
  await manager.close();
  manager = null;
  assert(!fs.existsSync(path.join(c.stateRoot, "runtime.lock")));
  assert(!fs.existsSync(path.join(c.stateRoot, "scan.lock")));
  manager = await open();
  await manager.call("start");
  const reopened = await manager.call("status");
  assert.equal(reopened.counts.works, 71);
  await manager.close();
  manager = null;
  const result = {
    conclusion: "一致",
    contract: "101 manager-bound lifecycle; Node data oracle retained",
    instanceRoot,
    refusals,
    works: 71,
    media: 284,
    incremental: {
      scope: incremental.scope,
      reused: incremental.counts.worksReused,
    },
    completedQuitAndReopen: true,
  };
  fs.writeFileSync(
    path.join(output, "manager-lifecycle.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  if (manager) await manager.close();
}
