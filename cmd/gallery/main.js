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
      "Gallery: serve | start | stop | restart | status | scan [--mode full|incremental] [--platform <id> | --platforms <JSON array>] [--author <directory>] --confirm-read-only | retain | validate | publish <id> | rollback <id> | connection [--config <file>]\n",
    );
    return;
  }
  // libuv's IO pool must be selected before the scan process starts. Per-disk
  // scheduling remains the actual HDD/SSD limit; this is only global capacity.
  if(command==="scan"&&process.env.GALLERY_SCAN_IO_POOL!=="64"){
    const child=require("node:child_process").spawn(process.execPath,[__filename,...argv],{windowsHide:true,stdio:"inherit",env:{...process.env,UV_THREADPOOL_SIZE:"64",GALLERY_SCAN_IO_POOL:"64"}});
    process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});
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
        desktopDataRoot: config.desktopDataRoot,
        tempRoot: config.tempRoot,
        logsRoot: config.logsRoot,
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
  const configPath = index >= 0 ? path.resolve(argv[index + 1]) : path.join(defaultRoot(), "config.json");
  if (command === "serve" || command === "scan") {
    ensureLayout(config);
    require("../../internal/runtime/logging.js").installRuntimeLog(
      config,
      command === "serve" ? "runtime-start.log" : "scan-launch.log",
    );
  }
  if (command === "manage") {
    let text="";for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>262144)throw Object.assign(new Error("Input too large"),{code:"MANAGEMENT_INPUT_TOO_LARGE"});}
    let input;try{input=text?JSON.parse(text):{};}catch{throw Object.assign(new Error("Invalid input"),{code:"MANAGEMENT_INPUT_INVALID"});}
    const result=await require("../../internal/runtime/management.js").manage(configPath,argv[1],input);
    process.stdout.write(JSON.stringify(result)+"\n");return;
  }
  if (["start", "stop", "restart", "status", "control"].includes(command)) {
    const c = require("../../internal/runtime/control.js");
    let result;
    if (command === "stop" || command === "restart") result = await c.stopRuntime(config);
    if (command === "start" || command === "restart") result = await c.startRuntime(config, configPath);
    if (command === "status") result = await c.control(config, "status");
    if (command === "control") result = await c.control(config, argv[1], {
      pid: argv.includes("--manager-pid") ? Number(argv[argv.indexOf("--manager-pid") + 1]) : null,
      confirmReadOnly: argv.includes("--confirm-read-only"),
    });
    process.stdout.write(JSON.stringify(result) + "\n"); return;
  }
  if (command === "retain") {
    ensureLayout(config);
    const result = await require("../../internal/publication/retention.js").retainGenerations(config);
    process.stdout.write(JSON.stringify({ removed: result.removed.length, bytes: result.bytes }) + "\n"); return;
  }
  if (command === "scan") {
    const { fullScan } = require("../../internal/indexing/task.js");
    const valueAfter = (flag) => {
      const at = argv.indexOf(flag);
      if (at < 0) return null;
      const value = argv[at + 1];
      if (!value || value.startsWith("--")) throw Object.assign(new Error(`Missing value for ${flag}`), { code: "COMMAND_ARGUMENT_MISSING" });
      return value;
    };
    let platformIds = null;
    if (valueAfter("--platforms") !== null) {
      try { platformIds = JSON.parse(valueAfter("--platforms")); }
      catch { throw Object.assign(new Error("Platforms must be a JSON array"), { code: "SCAN_PLATFORM_INVALID" }); }
    }
    const report = await fullScan(config, {
      confirmReadOnly: argv.includes("--confirm-read-only"),
      mode: valueAfter("--mode") || "full",
      platformId: valueAfter("--platform"),
      platformIds,
      authorDirectoryName: valueAfter("--author"),
    });
    const output = JSON.stringify({
        state: report.state,
        generationId: report.generationId,
        works: report.catalog.workCount,
        mode: report.mode,
        scope: report.scope,
        changes: report.changes,
      }) + "\n";
    await new Promise((resolve) => process.stdout.write(output, resolve));
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
        : await require("../../internal/publication/retention.js").withMaintenance(config, () => g.publishGeneration(config.instanceRoot, argv[1], {
            generationsRoot: config.generationsRoot,
            activePointerPath: config.activeGenerationPath,
          }));
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
    protectedRoots: config.protectedRoots,
  });
  const runtime = createRuntimeBootstrap({ config, onShutdownRequest: () => shutdown(), sourceWriteAttempts: () => guard.blockedCount() });
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
