"use strict";
// Isolated acceptance controller. Existing Node code serves reads only;
// the owned Go child is the only scanner and Catalog/Search writer.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn } = require("node:child_process");
const { repo, testRoot } = require("./prepare.cjs");
const { readRuntimeConfig } = require(
  path.join(repo, "src/instance/config.js"),
);
const { inside, noLinks } = require(path.join(repo, "src/library/io-paths.js"));
const { createRuntimeServer } = require(path.join(repo, "src/server/http.js"));
const { createManagerTestHost } = require(
  path.join(repo, "tools/manager/server.cjs"),
);
const { createGalleryReviewHost } = require(
  path.join(repo, "tools/validation/gallery-host.cjs"),
);
const { ROOT } = require(path.join(repo, "tools/demo/paths.cjs"));
const IDS = require(
  path.join(repo, "src/library/platforms.js"),
).PLATFORM_REGISTRY.map((p) => p.id);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function validate(file, raw) {
  const scanFile = path.join(path.dirname(file), "go-scan.json"),
    scan = JSON.parse(fs.readFileSync(scanFile));
  if (
    !scan.testOnly ||
    raw.deployment !== "staging" ||
    raw.mode !== "local" ||
    raw.listenAddress !== "127.0.0.1" ||
    raw.port === 8081 ||
    raw.liveUpdates !== true ||
    path.resolve(raw.instanceRoot) !== path.dirname(file) ||
    path.resolve(scan.database) !==
      path.join(path.dirname(file), "live/catalog.sqlite") ||
    !inside(raw.instanceRoot, file)
  )
    fail("ISOLATED_INSTANCE_REQUIRED");
  if (!inside(testRoot, raw.instanceRoot)) fail("ISOLATED_ROOT_REQUIRED");
  if (
    IDS.some((id) => raw.sources[id] !== scan.sources[id]) ||
    Object.keys(scan.sources).length !== 9
  )
    fail("SOURCE_BINDING_MISMATCH");
  if (scan.listingSource !== "filesystem" || Object.hasOwn(scan, "everything"))
    fail("LISTING_SOURCE_INVALID");
  for (const source of Object.values(scan.sources))
    if (inside(source, raw.instanceRoot) || inside(raw.instanceRoot, source))
      fail("SOURCE_RUNTIME_OVERLAP");
  for (const target of [raw.instanceRoot, file, scanFile, scan.database])
    noLinks(target);
  return scan;
}
function managerScan(s) {
  const c = s.counts || {};
  return {
    ...s,
    state: s.state === "COMPLETE" ? "READY" : s.state,
    works: c.worksCommitted || 0,
    observedWorks: c.worksPrepared || 0,
    platforms: s.progress?.platformResults || [],
    platformResults: s.progress?.platformResults || [],
    activePlatforms: s.progress?.activePlatforms || [],
    currentPlatform: s.progress?.activePlatforms?.[0],
    metadataStates: s.progress?.metadataStates || {},
    diagnosticCount: c.failures || 0,
    failure: s.failure ? { code: s.failure } : undefined,
    rssBytes: null,
    heapUsedBytes: c.heapBytes || 0,
    scope: {
      requestedPlatformIds: s.platformIds || IDS,
      effectivePlatformIds: s.platformIds || IDS,
    },
  };
}
async function createAcceptanceHost({
  configPath,
  exe,
  webPort = 18251,
  managerPort = 18252,
  syntheticDelay = 0,
  cpuProfile = false,
}) {
  const file = path.resolve(configPath),
    raw = JSON.parse(fs.readFileSync(file)),
    scanConfig = validate(file, raw),
    config = readRuntimeConfig(file);
  noLinks(exe);
  if (!fs.statSync(exe).isFile()) fail("GO_BINARY_REQUIRED");
  if (
    new Set([webPort, managerPort, config.port]).size !== 3 ||
    [webPort, managerPort].some(
      (p) => p === 8081 || !Number.isInteger(p) || p < 1024 || p > 65535,
    )
  )
    fail("ISOLATED_PORTS_REQUIRED");
  if (
    syntheticDelay &&
    Object.values(scanConfig.sources).some(
      (p) => !inside(path.resolve(config.instanceRoot, "../sources"), p),
    )
  )
    fail("SYNTHETIC_ONLY");
  const startedAtMs = Date.now(),
    logFile = path.join(config.logsRoot, "go-acceptance.jsonl");
  let service = null,
    child = null,
    scan = { running: false, state: "IDLE", platformIds: IDS },
    closing = false;
  const binaryHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(exe))
    .digest("hex");
  let persistence = Promise.resolve(),
    pendingState = null,
    stateWriting = false,
    lastProgressLog = 0,
    persistenceError = false;
  const record = (value) => {
    const line =
      JSON.stringify({ time: new Date().toISOString(), ...value }) + "\n";
    persistence = persistence
      .then(() => fs.promises.appendFile(logFile, line))
      .catch(() => {
        persistenceError = true;
      });
  };
  async function saveState() {
    if (stateWriting) return;
    stateWriting = true;
    try {
      while (pendingState !== null) {
        const text = pendingState;
        pendingState = null;
        const target = path.join(config.stateRoot, "go-scan-status.json"),
          temporary = target + ".tmp";
        await fs.promises.writeFile(temporary, text);
        await fs.promises.rename(temporary, target);
      }
    } catch {
      persistenceError = true;
    } finally {
      stateWriting = false;
    }
  }
  const update = (value) => {
    scan = value;
    pendingState = JSON.stringify(scan) + "\n";
    void saveState();
  };
  const runtimeStatus = () => ({
    state: service ? "READY" : "STOPPED",
    startedAtMs,
    pid: process.pid,
    instanceId: config.instanceId,
    deployment: "staging",
    testOnly: true,
    scanner: "go",
    scan: managerScan(scan),
    generations: [],
    restartRequired: false,
    ...(persistenceError
      ? { diagnosticCode: "STATUS_PERSISTENCE_FAILED" }
      : {}),
  });
  async function startService() {
    if (service) return runtimeStatus();
    const next = createRuntimeServer({
      config,
      generation: null,
      status: runtimeStatus,
      onScan: () => fail("GO_MANAGER_REQUIRED"),
    });
    await next.start();
    service = next;
    return runtimeStatus();
  }
  async function stopService() {
    if (service) {
      const owned = service;
      service = null;
      await owned.close();
    }
    return runtimeStatus();
  }
  async function startScan(input = {}) {
    if (child || scan.running) fail("SCAN_IN_USE");
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("SCAN_INPUT_INVALID");
    const mode = input.mode ?? "incremental";
    if (!["full", "incremental"].includes(mode)) fail("SCAN_MODE_INVALID");
    validate(file, JSON.parse(fs.readFileSync(file)));
    const platformIds = input.platformIds || IDS;
    if (
      !Array.isArray(platformIds) ||
      !platformIds.length ||
      new Set(platformIds).size !== platformIds.length ||
      platformIds.some((id) => !IDS.includes(id))
    )
      fail("PLATFORMS_INVALID");
    const author = input.authorDirectoryName ?? "";
    if (
      typeof author !== "string" ||
      (author &&
        (platformIds.length !== 1 ||
          /[\\/:\x00]/.test(author) ||
          [".", ".."].includes(author)))
    )
      fail("AUTHOR_SCOPE_INVALID");
    update({
      running: true,
      state: "STARTING",
      phase: "LISTING",
      startedAtMs: Date.now(),
      platformIds,
      mode,
      counts: {},
    });
    let pending = "",
      finished = false;
    const owned = spawn(
      exe,
      [
        "--config",
        path.join(config.instanceRoot, "go-scan.json"),
        "--platforms",
        platformIds.join(","),
        "--mode",
        mode,
        ...(author ? ["--author", author] : []),
        ...(syntheticDelay
          ? ["--synthetic-delay-ms", String(syntheticDelay)]
          : []),
        ...(cpuProfile ? ["--cpu-profile"] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child = owned;
    owned.stdout.on("data", (data) => {
      pending += data.toString();
      if (pending.length > 1048576) {
        owned.stdin.write("cancel\n");
        return;
      }
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          update({ ...value, pid: owned.pid });
          if (!value.running || Date.now() - lastProgressLog >= 2000) {
            lastProgressLog = Date.now();
            record({ event: "scan.progress", ...value });
          }
        } catch {
          owned.stdin.write("cancel\n");
        }
      }
    });
    // The real-data child emits codes/aggregate telemetry, never source contents.
    owned.stderr.on("data", () => {});
    owned.stdin.on("error", () => {});
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      if (child === owned) child = null;
      if (
        scan.running ||
        (code !== 0 && scan.state !== "CANCELLED" && scan.state !== "FAILED")
      )
        update({
          ...scan,
          running: false,
          state: "FAILED",
          finishedAtMs: Date.now(),
          failure: error ? "SCAN_START_FAILED" : "SCAN_NOT_COMPLETE",
        });
      record({ event: "scan.exit", code, state: scan.state });
    };
    owned.once("error", () => finish(null, true));
    owned.once("exit", (code) => finish(code, false));
    record({ event: "scan.started", pid: owned.pid, platformIds, binaryHash });
    return managerScan(scan);
  }
  async function control(method, args) {
    if (method === "status")
      return {
        ...(service ? service.snapshotState() : runtimeStatus()),
        localControl: true,
        testOnly: true,
      };
    if (method === "start") return startService();
    if (method === "stop") return stopService();
    if (method === "restart") {
      await stopService();
      return startService();
    }
    if (method === "scan") return startScan({ mode: "full" });
    if (method === "openDirectory" || method === "openFinding")
      return { nativeHostRequired: true };
    const [op, input = {}] = args;
    if (op === "scan.start") return startScan(input);
    if (op === "scan.status") return managerScan(scan);
    if (op === "scan.cancel") {
      if (child && scan.running) {
        child.stdin.write("cancel\n");
        scan.cancelRequested = true;
      }
      return managerScan(scan);
    }
    if (op === "config.read")
      return {
        value: raw,
        revision: crypto
          .createHash("sha256")
          .update(JSON.stringify(raw))
          .digest("hex"),
      };
    if (op === "logs.list")
      return {
        items: fs.existsSync(logFile) ? [{ name: path.basename(logFile) }] : [],
      };
    if (op === "logs.read") {
      if (input.name !== path.basename(logFile)) fail("LOG_NOT_FOUND");
      const stat = fs.statSync(logFile),
        fd = fs.openSync(logFile, "r");
      try {
        const size = Math.min(stat.size, 262144),
          b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, stat.size - size);
        return { text: b.toString() };
      } finally {
        fs.closeSync(fd);
      }
    }
    if (op === "storage.read") return { cache: { bytes: 0 }, testOnly: true };
    if (op === "validation.status") return { running: false, state: "IDLE" };
    if (op === "diagnostics.run")
      return {
        testOnly: true,
        checks: IDS.map((platform) => ({
          platform,
          available: fs.existsSync(raw.sources[platform]),
        })),
        scanner: { language: "go", binaryHash },
      };
    // No fallback into the old Node scan/administrative writer.
    fail("ACCEPTANCE_OPERATION_UNSUPPORTED");
  }
  let web, manager;
  try {
    await startService();
    web = await createGalleryReviewHost({
      port: webPort,
      backend: config.port,
      configPath: file,
      validateConfig: (value) => validate(file, value),
    });
    manager = await createManagerTestHost(file, {
      port: managerPort,
      ui: "manager",
      validateConfig: (value) => validate(file, value),
      control,
      assetsRoot: process.env.GALLERY_ASSETS_ROOT
        ? path.join(process.env.GALLERY_ASSETS_ROOT, "fonts")
        : null,
      galleryUrl: web.url,
    });
  } catch (e) {
    await manager?.close();
    await web?.close();
    await stopService();
    throw e;
  }
  const result = {
    testOnly: true,
    pid: process.pid,
    backend: config.url,
    web: web.url,
    manager: manager.url,
    instanceId: config.instanceId,
    startedAtMs,
    binaryHash,
  };
  fs.writeFileSync(
    path.join(config.stateRoot, "go-acceptance-host.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  record({ event: "acceptance.ready", ...result });
  return {
    ...result,
    control,
    async close() {
      if (closing) return;
      closing = true;
      if (child) {
        const owned = child;
        await new Promise((resolve) => {
          owned.once("exit", resolve);
          owned.stdin.write("cancel\n");
        });
      }
      await manager.close();
      await web.close();
      await stopService();
      while (stateWriting) await new Promise((r) => setTimeout(r, 10));
      await persistence;
    },
  };
}
if (require.main === module) {
  const at = process.argv.indexOf("--config"),
    ep = process.argv.indexOf("--exe");
  if (at < 0 || ep < 0) throw Error("EXPLICIT_TEST_CONFIG_AND_BINARY_REQUIRED");
  const option = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? fallback : Number(process.argv[i + 1]);
  };
  createAcceptanceHost({
    configPath: process.argv[at + 1],
    exe: process.argv[ep + 1],
    webPort: option("--web-port", 18251),
    managerPort: option("--manager-port", 18252),
    cpuProfile: process.argv.includes("--cpu-profile"),
  })
    .then((host) => {
      console.log(JSON.stringify(host));
      for (const s of ["SIGINT", "SIGTERM"])
        process.on(s, () => void host.close().then(() => process.exit()));
    })
    .catch((e) => {
      console.error(e.code || "ACCEPTANCE_START_FAILED");
      process.exitCode = 1;
    });
}
module.exports = { createAcceptanceHost, validate, managerScan };
