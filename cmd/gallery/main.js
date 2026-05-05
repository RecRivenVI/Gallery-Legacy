#!/usr/bin/env node
"use strict";
const path = require("node:path"),
  readline = require("node:readline");
const {
  readRuntimeConfig,
  defaultRoot,
  ensureLayout,
} = require("../../internal/instance/config.js");
const { writeJson } = require("../../internal/instance/files.js");
async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "serve";
  if (command === "--help" || argv.includes("--help")) {
    process.stdout.write(
      "Gallery: serve | scan --confirm-read-only | validate | publish <id> | rollback <id> | connection [--config <file>]\n",
    );
    return;
  }
  const index = argv.indexOf("--config"),
    config = readRuntimeConfig(
      index >= 0
        ? path.resolve(argv[index + 1])
        : path.join(defaultRoot(), "config.json"),
    );
  if (command === "connection") {
    process.stdout.write(
      JSON.stringify({
        url: config.url,
        instanceRoot: config.instanceRoot,
        instanceId: config.instanceId,
      }) + "\n",
    );
    return;
  }
  // Native SQLite and helper programs must use instance-owned temporary space too.
  process.env.TEMP = config.tempRoot;
  process.env.TMP = config.tempRoot;
  process.env.SQLITE_TMPDIR = config.tempRoot;
  process.env.PSModuleAnalysisCachePath = path.join(
    config.tempRoot,
    "powershell-module-cache",
  );
  if (command === "scan") {
    const { fullScan } = require("../../internal/indexing/task.js");
    const report = await fullScan(config, {
      confirmReadOnly: argv.includes("--confirm-read-only"),
    });
    process.stdout.write(
      JSON.stringify({
        state: report.state,
        generationId: report.generationId,
        works: report.catalog.workCount,
      }) + "\n",
    );
    return;
  }
  if (["validate", "publish", "rollback"].includes(command)) {
    const g = require("../../internal/publication/generations.js");
    const result =
      command === "validate"
        ? g.resolveActiveGeneration(config.instanceRoot, {
            generationsRoot: config.generationsRoot,
            activePointerPath: config.activeGenerationPath,
          })
        : g.publishGeneration(config.instanceRoot, argv[1], {
            generationsRoot: config.generationsRoot,
            activePointerPath: config.activeGenerationPath,
          });
    process.stdout.write(
      JSON.stringify({ state: "READY", generationId: result.generationId }) +
        "\n",
    );
    return;
  }
  if (command !== "serve")
    throw Object.assign(new Error("Unknown command"), {
      code: "COMMAND_INVALID",
    });
  const {
    createRuntimeBootstrap,
  } = require("../../internal/runtime/bootstrap.js");
  const {
    installWriteGuard,
  } = require("../../internal/library/write-guard.js");
  ensureLayout(config);
  const guard = installWriteGuard({
    instanceRoot: config.instanceRoot,
    protectedRoots: config.platforms,
  });
  const runtime = createRuntimeBootstrap({ config });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await runtime.close();
      writeJson(path.join(config.reportsRoot, "runtime-safety.json"), {
        sourceWriteAttempts: guard.blockedCount(),
      });
    } finally {
      guard.restore();
      process.exit(0);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const ready = await runtime.start();
    process.stdout.write(
      JSON.stringify({
        event: "ready",
        url: ready.url,
        generationId: ready.generationId,
        pid: process.pid,
      }) + "\n",
    );
    if (argv.includes("--host")) {
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        try {
          const m = JSON.parse(line);
          if (m.type === "stop") void shutdown();
          if (m.type === "manager") runtime.manager(m.pid || null);
        } catch {}
      });
      input.on("close", () => void shutdown());
    }
  } catch (e) {
    guard.restore();
    throw e;
  }
}
if (require.main === module)
  main().catch((e) => {
    process.stderr.write((e.code || "FAILED") + "\n");
    process.exitCode = 1;
  });
module.exports = { main };
