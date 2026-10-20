"use strict";
// Product scan dispatch. Node static recovery stays explicit; live writes use Go.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn } = require("node:child_process");
const { ensureLayout } = require("../instance/config.js");
const { acquireOwnership } = require("../instance/ownership.js");
const { writeJson, readJson } = require("../instance/files.js");
const { ensureLive } = require("../catalog/live.js");
const { resolveActiveGeneration } = require("../publication/generations.js");
const { scanPlatforms } = require("./scope.js");
const { createProgressWriter } = require("./progress.js");
function fail(code) {
  return Object.assign(new Error(code), { code });
}
async function fullScan(config, options = {}) {
  if (!config.liveUpdates)
    return require("./task.js").fullScan(config, options);
  if (options.confirmReadOnly !== true)
    throw fail("READ_ONLY_CONFIRMATION_REQUIRED");
  const mode = options.mode || "full";
  if (!["full", "incremental"].includes(mode)) throw fail("SCAN_MODE_INVALID");
  const platforms = scanPlatforms(options) || config.platforms.map((p) => p.id),
    author = options.authorDirectoryName || "";
  if (
    author &&
    (platforms.length !== 1 ||
      /[\\/:\x00-\x1f]/.test(author) ||
      [".", ".."].includes(author))
  )
    throw fail("AUTHOR_DIRECTORY_INVALID");
  const localFile = path.resolve(
    __dirname,
    "../../tools/build/paths.local.json",
  );
  const local = fs.existsSync(localFile) ? readJson(localFile) : {};
  const exe =
    process.env.GALLERY_SCANNER ||
    (local.output ? path.join(local.output, "bin/gallery-scan.exe") : null) ||
    path.resolve(__dirname, "../../bin/gallery-scan.exe");
  if (!fs.existsSync(exe)) throw fail("SCANNER_UNAVAILABLE");
  ensureLayout(config);
  const owner = await acquireOwnership(config, "scan"),
    id = options.generationId || "scan-" + crypto.randomUUID();
  const progress = createProgressWriter(config.scanStatusPath),
    startedAtMs = Date.now();
  let child,
    timer,
    last,
    report,
    cancelSent = false;
  const persist = (value) => {
    const counts = value.counts || {},
      results = value.progress?.platformResults || [];
    last = {
      ...value,
      protocolVersion: 1,
      pid: process.pid,
      identity: owner.identity,
      generationId: id,
      state: value.state === "COMPLETE" ? "READY" : value.state,
      mode,
      effectiveMode: mode,
      startedAtMs,
      works: counts.worksCommitted || 0,
      indexedWorks: counts.worksCommitted || 0,
      observedWorks: counts.worksPrepared || 0,
      reusedWorks: counts.worksReused || 0,
      actualMedia: counts.mediaCommitted || 0,
      platforms: results,
      platformResults: results,
      activePlatforms: value.progress?.activePlatforms || [],
      metadataStates: value.progress?.metadataStates || {},
      diagnosticCount: counts.failures || 0,
      scope: {
        requestedPlatformIds: platforms,
        effectivePlatformIds: platforms,
        authorDirectoryName: author || null,
      },
      changes: {
        worksAdded: counts.worksAdded || 0,
        worksUpdated: counts.worksUpdated || 0,
        worksDeleted: counts.worksDeleted || 0,
      },
      failure: value.failure ? { code: value.failure } : null,
    };
    progress.enqueue(last);
  };
  try {
    persist({
      state: "PREPARING",
      running: true,
      phase: "LISTING",
      counts: {},
    });
    await progress.flush();
    const baseline = fs.existsSync(config.activeGenerationPath)
      ? resolveActiveGeneration(config.instanceRoot, {
          generationsRoot: config.generationsRoot,
          activePointerPath: config.activeGenerationPath,
        })
      : null;
    await ensureLive(config, baseline);
    const scanFile = path.join(config.stateRoot, "scanner.json");
    writeJson(scanFile, {
      testOnly: true,
      instanceRoot: config.instanceRoot,
      database: path.join(config.instanceRoot, "live/catalog.sqlite"),
      listingSource: "filesystem",
      sources: config.sources,
    });
    const args = [
      "--config",
      scanFile,
      "--mode",
      mode,
      "--platforms",
      platforms.join(","),
      ...(author ? ["--author", author] : []),
    ];
    const exit = await new Promise((resolve, reject) => {
      child = spawn(exe, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let pending = "",
        parseError = null;
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        if (pending.length > 1048576) {
          parseError = fail("SCAN_PROGRESS_INVALID");
          child.stdin.write("cancel\n");
          return;
        }
        let at;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (!line) continue;
          try {
            persist(JSON.parse(line));
          } catch (error) {
            parseError = fail("SCAN_PROGRESS_INVALID");
            child.stdin.write("cancel\n");
          }
        }
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.once("error", () => reject(fail("SCANNER_UNAVAILABLE")));
      child.once("close", (code) =>
        parseError ? reject(parseError) : resolve(code),
      );
      timer = setInterval(() => {
        const request = readJson(
          path.join(config.stateRoot, "scan-cancel.json"),
        );
        if (!cancelSent && request?.generationId === id) {
          cancelSent = true;
          child.stdin.write("cancel\n");
        }
      }, 200);
    });
    if (last?.state === "CANCELLED") throw fail("SCAN_CANCELLED");
    if (exit !== 0 || last?.state !== "READY")
      throw fail(last?.failure?.code || "SCAN_NOT_COMPLETE");
    const { CatalogReader } = require("../catalog/reader.js");
    const reader = new CatalogReader(
      path.join(config.instanceRoot, "live/catalog.sqlite"),
      "live",
      config.sources,
      { live: true },
    );
    let counts;
    try {
      counts = reader.stats();
    } finally {
      reader.close();
    }
    report = {
      state: "READY",
      generationId: id,
      mode,
      effectiveMode: mode,
      changes: last.changes,
      scope: last.scope,
      elapsedMs: Date.now() - startedAtMs,
      catalog: { workCount: counts.works, mediaCount: counts.media },
      build: { counts },
      searchRebuilt: false,
      sourceWriteAttempts: null,
      scanner: "go",
      counts: last.counts,
    };
    writeJson(path.join(config.reportsRoot, id + ".json"), report);
    return report;
  } catch (error) {
    persist({
      ...last,
      state: error.code === "SCAN_CANCELLED" ? "CANCELLED" : "FAILED",
      running: false,
      finishedAtMs: Date.now(),
      failure: error.code || "SCAN_NOT_COMPLETE",
    });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    try {
      await progress.flush();
    } finally {
      await owner.release();
    }
  }
}
module.exports = { fullScan };
