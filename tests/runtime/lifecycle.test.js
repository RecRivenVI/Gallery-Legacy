"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const { fixture } = require("../support/runtime.js");
const {
  createRuntimeBootstrap,
} = require("../../internal/runtime/bootstrap.js");
const { normalizeRuntimeConfig } = require("../../internal/instance/config.js");
const {
  processIdentity,
  sameIdentity,
} = require("../../internal/instance/ownership.js");
const { hashDatabaseFile } = require("../../internal/catalog/file-hash.js");
function runtime(f) {
  const r = createRuntimeBootstrap({ config: f.config });
  f.cleanup.push(() => r.close());
  return r;
}
test("normal lifecycle, independent instances and duplicate ownership", async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  const ga = a.build();
  a.publish();
  b.build();
  b.publish();
  const r = runtime(a),
    s = runtime(b);
  await r.start();
  await s.start();
  assert.equal(r.status().state, "READY");
  await assert.rejects(createRuntimeBootstrap({ config: a.config }).start(), {
    code: "INSTANCE_IN_USE",
  });
  const p = processIdentity(process.pid);
  assert.ok(sameIdentity(p, processIdentity(process.pid)));
  assert.equal(sameIdentity(p, { ...p, start: "different" }), false);
  await r.close();
  await s.close();
  assert.equal(r.status().managerPid, null);
  assert.equal(
    fs.existsSync(path.join(a.config.stateRoot, "runtime.lock")),
    false,
  );
  assert.equal(hashDatabaseFile(ga.catalogPath), ga.catalogFacts.sha256);
  assert.equal(hashDatabaseFile(ga.searchIndexPath), ga.searchFacts.sha256);
});
test("stale READY and reused PID identity recover; live identity never stolen", async (t) => {
  const f = await fixture(t);
  f.build();
  f.publish();
  const p = processIdentity(process.pid);
  fs.writeFileSync(
    f.config.statusPath,
    JSON.stringify({ state: "READY", managerPid: 1 }),
  );
  fs.writeFileSync(
    path.join(f.config.stateRoot, "runtime.lock"),
    JSON.stringify({
      identity: { ...p, start: "previous-process" },
      token: "stale",
    }),
  );
  const r = runtime(f);
  await r.start();
  assert.equal(r.status().recovered, true);
  assert.equal(r.status().managerPid, null);
  await r.close();
  fs.writeFileSync(
    path.join(f.config.stateRoot, "runtime.lock"),
    JSON.stringify({ identity: p, token: "live" }),
  );
  await assert.rejects(createRuntimeBootstrap({ config: f.config }).start(), {
    code: "INSTANCE_IN_USE",
  });
});
test("port conflict fails without stale READY and process kill releases ownership", async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  a.build();
  a.publish();
  b.build();
  b.publish();
  const r = runtime(a);
  await r.start();
  const blocked = createRuntimeBootstrap({
    config: { ...b.config, port: a.config.port },
  });
  await assert.rejects(blocked.start(), { code: "EADDRINUSE" });
  assert.equal(
    JSON.parse(fs.readFileSync(b.config.statusPath)).state,
    "FAILED",
  );
  assert.equal(
    fs.existsSync(path.join(b.config.stateRoot, "runtime.lock")),
    false,
  );
  await r.close();
  const child = spawn(
    process.execPath,
    [
      path.resolve(__dirname, "../../cmd/gallery/main.js"),
      "serve",
      "--config",
      path.join(a.config.instanceRoot, "config.json"),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let errorCode = "";
  child.stderr.on("data", (chunk) => {
    errorCode += String(chunk);
  });
  await new Promise((resolve, reject) => {
    child.once("exit", () =>
      reject(new Error("child startup failed: " + errorCode)),
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes('"event":"ready"')) resolve();
    });
  });
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
  const recovered = runtime(a);
  await recovered.start();
  assert.equal(recovered.status().recovered, true);
});
test("source, generation, writable paths and listen boundaries are fail closed", async (t) => {
  const f = await fixture(t, { empty: true });
  for (const input of [
    { catalogPath: path.join(f.config.instanceRoot, "old.sqlite") },
    {
      sources: {
        ...f.bindings,
        pixivFANBOX: path.join(f.bindings.pixiv, "nested"),
      },
    },
    { instanceRoot: path.join(f.bindings.pixiv, "instance") },
    { sources: { ...f.bindings, pixiv: f.config.cacheRoot } },
    { cacheRoot: path.join(f.config.generationsRoot, "ready", "cache") },
    { stateRoot: path.dirname(f.config.instanceRoot) },
    { tempRoot: f.config.logsRoot },
    { host: "0.0.0.0" },
    { host: "192.168.1.2" },
  ])
    assert.throws(() => normalizeRuntimeConfig({ ...f.config, ...input }));
  assert.equal(
    normalizeRuntimeConfig({ ...f.config, host: "192.168.1.2", mode: "lan" })
      .mode,
    "lan",
  );
});
