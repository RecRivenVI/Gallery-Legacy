import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { openManager } from "./manager-driver.mjs";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { freePort } = require("../../test/support/runtime.js");
const {
  GALLERY_TEST_ROOT: root,
  GALLERY_NODE_REFERENCE_ROOT: reference,
  GALLERY_RUNTIME_EXE: exe,
  GALLERY_LIFECYCLE_EVIDENCE: output,
} = process.env;
if (!root || !reference || !exe || !output)
  throw Error("explicit test bindings required");
const input = JSON.parse(
  fs.readFileSync(path.join(output, "lifecycle-minimal.json")),
).input;
const sources = JSON.parse(
  fs.readFileSync(path.join(input, "Input/instance/config.json")),
).sources;
const { normalizeRuntimeConfig, ensureLayout } = require(
  path.join(reference, "src/instance/config.js"),
);
const generations = require(
  path.join(reference, "src/publication/generations.js"),
);
const results = [];
function run(program, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(program, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    c.stdout.on("data", (b) => (stdout += b));
    c.stderr.on("data", (b) => (stderr += b));
    c.once("error", reject);
    c.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
for (const kind of ["Node", "Go"]) {
  const dir = fs.mkdtempSync(path.join(root, `Static-${kind}-`));
  const raw = {
    instanceRoot: dir,
    sources,
    liveUpdates: false,
    port: await freePort(),
    retention: { enabled: false },
  };
  const c = normalizeRuntimeConfig(raw);
  ensureLayout(c);
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  const program = kind === "Node" ? process.execPath : exe;
  const prefix =
    kind === "Node" ? [path.join(reference, "bin/gallery.cjs")] : [];
  let manager, socket;
  const snapshots = [];
  if (kind === "Node") {
    const scan = await run(program, [
      ...prefix,
      "scan",
      "--config",
      file,
      "--confirm-read-only",
    ]);
    assert.equal(scan.code, 0, scan.stderr);
  } else {
    process.env.GALLERY_ASSETS_ROOT = path.join(reference, "resources");
    manager = await openManager(c, file);
    try {
      await manager.call("start");
      socket = new WebSocket(c.url.replace("http:", "ws:") + "/api/v1/events");
      socket.on("message", (data) => snapshots.push(JSON.parse(data)));
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await manager.call("manage", "scan.start", { confirmReadOnly: true });
      let state;
      do {
        state = await manager.call("manage", "scan.status");
        if (state.running) await new Promise((r) => setTimeout(r, 50));
      } while (state.running);
      assert.equal(state.state, "READY", JSON.stringify(state));
      const deadline = Date.now() + 10000;
      for (;;) {
        const status = await manager.call("status");
        if (status.libraryReady && status.counts.works === 71) break;
        if (Date.now() > deadline) throw Error("static checkpoint not applied");
        await new Promise((r) => setTimeout(r, 100));
      }
      while (!snapshots.some((x) => x.data?.counts?.works === 71)) {
        if (Date.now() > deadline)
          throw Error("WebSocket did not observe dataset replacement");
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      const closed =
        socket && new Promise((resolve) => socket.once("close", resolve));
      await manager.close();
      if (closed) await closed;
    }
  }
  const ready = generations.resolveActiveGeneration(dir, {
    generationsRoot: c.generationsRoot,
    activePointerPath: c.activeGenerationPath,
  });
  assert.equal(ready.catalogFacts.workCount, 71);
  const { CatalogReader } = require(
    path.join(reference, "src/catalog/reader.js"),
  );
  const reader = new CatalogReader(
    ready.catalogPath,
    ready.generationId,
    sources,
  );
  const stats = reader.stats();
  reader.close();
  assert.equal(stats.media, 284);
  results.push({
    kind,
    staticAcceptedByFrozenNode: true,
    websocketReplacementAndShutdown: kind === "Go" ? true : null,
    works: stats.works,
    media: stats.media,
    instance: dir,
    generation: ready.generationId,
  });
}
fs.writeFileSync(
  path.join(output, "static-lifecycle.json"),
  JSON.stringify({ conclusion: "一致", results }, null, 2) + "\n",
);
console.log(JSON.stringify({ conclusion: "一致", results }));
