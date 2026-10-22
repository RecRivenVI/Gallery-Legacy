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
  throw Error("Explicit synthetic bindings required");
process.env.GALLERY_ASSETS_ROOT = path.join(reference, "resources");
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const { PLATFORM_REGISTRY } = require(
  path.join(reference, "src/library/platforms.js"),
);
const ownership = require(path.join(reference, "src/instance/ownership.js"));
const DB = require(path.join(reference, "node_modules/better-sqlite3"));
const { freePort } = require("../../test/support/runtime.js");
const run =
  process.env.GALLERY_INTERRUPTION_INPUT ||
  fs.mkdtempSync(path.join(root, "Interrupt-"));
const sources = {};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
for (const p of PLATFORM_REGISTRY) {
  sources[p.id] = path.join(run, "sources", p.id);
  if (process.env.GALLERY_INTERRUPTION_INPUT) {
    assert(fs.statSync(sources[p.id]).isDirectory());
    continue;
  }
  const count = p.id === "Venera" ? 5000 : 1;
  const metadata = JSON.stringify({
    title: "Synthetic interruption",
    padding: "x".repeat(8192),
  });
  for (let i = 0; i < count; i++) {
    const w = path.join(sources[p.id], "700", `2026-01-01_00-00-00_work-${i}`);
    fs.mkdirSync(w, { recursive: true });
    fs.writeFileSync(path.join(w, "1.png"), png);
    fs.writeFileSync(path.join(w, "metadata.json"), metadata);
  }
}
const instanceRoot = fs.mkdtempSync(path.join(run, "instance-"));
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
const readState = () => JSON.parse(fs.readFileSync(c.scanStatusPath));
function facts() {
  const db = new DB(path.join(instanceRoot, "live/catalog.sqlite"), {
    readonly: true,
  });
  try {
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const ids = db
      .prepare("select work_id from works order by work_id")
      .all()
      .map((x) => x.work_id);
    assert.equal(
      db.prepare("select count(*) n from live_search_docs").get().n,
      ids.length,
    );
    assert.equal(
      db.prepare("select count(*) n from live_work_sort").get().n,
      ids.length,
    );
    return ids;
  } finally {
    db.close();
  }
}
async function inProgress(manager) {
  await manager.call("manage", "scan.start", { confirmReadOnly: true });
  const deadline = Date.now() + 30000;
  for (;;) {
    const s = readState();
    if (s.running && s.counts.worksCommitted > 0) return s;
    if (!s.running || Date.now() > deadline)
      throw Error("Partial commit scenario did not occur");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const observations = [];
let manager;
try {
  manager = await openManager(c, file);
  await manager.call("start");
  const before = await inProgress(manager),
    ids = facts();
  await manager.close();
  manager = null;
  const after = readState();
  assert.equal(after.state, "CANCELLED");
  assert.equal(after.failure.code, "SCAN_CANCELLED");
  const retained = facts();
  assert(ids.every((id) => retained.includes(id)));
  assert.equal(retained.length, after.counts.worksCommitted);
  assert(!fs.existsSync(path.join(c.stateRoot, "runtime.lock")));
  assert(!fs.existsSync(path.join(c.stateRoot, "scan.lock")));
  observations.push({
    case: "quit-during-scan",
    before: before.counts.worksCommitted,
    committed: retained.length,
    state: after.state,
    leaseReleased: true,
  });
  manager = await openManager(c, file);
  const restored = await manager.call("start");
  assert.equal((await manager.call("status")).counts.works, retained.length);
  await inProgress(manager);
  const beforeCancel = facts();
  await manager.call("manage", "scan.cancel");
  let cancelled;
  do {
    cancelled = await manager.call("manage", "scan.status");
    if (cancelled.running) await new Promise((r) => setTimeout(r, 20));
  } while (cancelled.running);
  assert.equal(cancelled.state, "CANCELLED");
  assert(beforeCancel.every((id) => facts().includes(id)));
  observations.push({
    case: "cancel-command",
    state: cancelled.state,
    committed: facts().length,
  });
  await inProgress(manager);
  const beforeCrash = facts(),
    expected = await ownership.processIdentity(manager.pid);
  assert(
    expected &&
      expected.pid === manager.pid &&
      expected.exe ===
        process.env.GALLERY_RUNTIME_EXE.replaceAll("/", "\\").toLowerCase(),
  );
  assert(
    ownership.sameIdentity(
      expected,
      await ownership.processIdentity(manager.pid),
    ),
  );
  process.kill(manager.pid);
  await assert.rejects(manager.close());
  manager = null;
  const crashRetained = facts();
  assert(beforeCrash.every((id) => crashRetained.includes(id)));
  manager = await openManager(c, file);
  await manager.call("start");
  const failed = await manager.call("manage", "scan.status");
  assert.equal(failed.failure.code, "SCAN_OWNER_EXITED");
  assert.equal(
    (await manager.call("status")).counts.works,
    crashRetained.length,
  );
  observations.push({
    case: "writer-crash-reopen",
    committed: crashRetained.length,
    state: failed.state,
    code: failed.failure.code,
  });
  await manager.close();
  manager = null;
  fs.writeFileSync(
    path.join(output, "manager-interruption.json"),
    JSON.stringify({ conclusion: "一致", run, observations }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ conclusion: "一致", observations }));
} finally {
  if (manager) await manager.close();
}
