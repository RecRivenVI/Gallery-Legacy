"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const {
  buildGeneration,
  publishGeneration,
} = require("../publication/generations.js");
const { ensureLayout } = require("../instance/config.js");
const { acquireOwnership } = require("../instance/ownership.js");
const { readJson, writeJson } = require("../instance/files.js");
const { installWriteGuard } = require("../library/write-guard.js");
function safeCode(error) {
  const c = String(error?.code || "BUILD_FAILED");
  return /^[a-zA-Z0-9_]{1,64}$/.test(c) ? c : "BUILD_FAILED";
}
function aggregate(report) {
  return {
    state: report.state,
    global: report.global,
    counts: report.catalogCounts,
    platforms: report.platforms.map((p) => ({
      platformId: p.platformId,
      status: p.status,
      filesystemIndexing: p.filesystemIndexing,
      metadataEnrichment: p.metadataEnrichment,
      authors: p.observation?.authorsObserved || 0,
      works: p.preparation?.preparedWorks || 0,
      media: p.media,
      metadataStates: p.preparation?.metadataStates || {},
      timings: p.timings,
      collisions: p.sourceIdentityCollisions,
      diagnostics: p.observation?.diagnostics?.length || 0,
      error: p.error ? { code: p.error.code } : null,
    })),
  };
}
async function fullScan(
  config,
  { confirmReadOnly = false, generationId = null, io = null } = {},
) {
  if (confirmReadOnly !== true)
    throw Object.assign(new Error("Read-only source confirmation required"), {
      code: "READ_ONLY_CONFIRMATION_REQUIRED",
    });
  ensureLayout(config);
  const previous = readJson(config.activeGenerationPath)?.generationId || null;
  const owner = await acquireOwnership(config, "scan");
  const id =
    generationId ||
    "scan-" +
      new Date().toISOString().replace(/[^0-9]/g, "") +
      "-" +
      crypto.randomBytes(3).toString("hex");
  const startedAtMs = Date.now();
  const state = {
    protocolVersion: 1,
    state: "SCANNING",
    running: true,
    pid: process.pid,
    identity: owner.identity,
    generationId: id,
    startedAtMs,
    finishedAtMs: null,
    elapsedMs: 0,
    currentPlatform: null,
    observedWorks: 0,
    indexedWorks: 0,
    actualMedia: 0,
    metadataStates: {},
    diagnosticCount: 0,
    throughput: 0,
    memory: {},
    peakMemory: { rss: 0, heapUsed: 0 },
    platforms: [],
    activeGenerationBefore: previous,
    restartRequired: false,
    failure: null,
  };
  const platforms = new Map();
  let last = 0,
    report = null,
    searchStarted = 0,
    searchTimeMs = 0;
  function persist(force = false) {
    if (!force && Date.now() - last < 500) return;
    last = Date.now();
    state.elapsedMs = last - startedAtMs;
    state.throughput = state.indexedWorks / Math.max(1, state.elapsedMs / 1000);
    const m = process.memoryUsage();
    state.memory = { rss: m.rss, heapUsed: m.heapUsed };
    state.peakMemory.rss = Math.max(state.peakMemory.rss, m.rss);
    state.peakMemory.heapUsed = Math.max(state.peakMemory.heapUsed, m.heapUsed);
    writeJson(config.scanStatusPath, state);
  }
  let guard = null;
  try {
    persist(true);
    guard = installWriteGuard({
      instanceRoot: config.instanceRoot,
      protectedRoots: config.platforms,
    });
    const result = buildGeneration({
      instanceRoot: config.instanceRoot,
      generationsRoot: config.generationsRoot,
      generationId: id,
      requireCompleteCatalog: true,
      catalogOptions: {
        platformRoots: config.sources,
        batchSize: 500,
        nestedSampleLimit: 32,
        io,
      },
      onCatalogReport: (value) => {
        report = aggregate(value);
      },
      onProgress: (e) => {
        if (e.platformId) {
          const p = platforms.get(e.platformId) || { platformId: e.platformId };
          for (const k of [
            "authors",
            "observedWorks",
            "indexedWorks",
            "actualMedia",
            "metadataStates",
            "diagnostics",
            "timings",
            "status",
          ])
            if (e[k] !== undefined) p[k] = e[k];
          platforms.set(e.platformId, p);
          state.currentPlatform = e.platformId;
          state.platforms = [...platforms.values()];
          for (const k of ["observedWorks", "indexedWorks", "actualMedia"])
            state[k] = state.platforms.reduce((n, p) => n + (p[k] || 0), 0);
          state.metadataStates = {};
          for (const p of state.platforms)
            for (const [k, v] of Object.entries(p.metadataStates || {}))
              state.metadataStates[k] = (state.metadataStates[k] || 0) + v;
          state.diagnosticCount = state.platforms.reduce(
            (n, p) => n + (p.diagnostics || 0),
            0,
          );
        }
        if (e.state && e.state !== "READY") state.state = e.state;
        if (e.phase === "SEARCH_BUILD_START") searchStarted = Date.now();
        if (e.phase === "SEARCH_FINALIZE")
          searchTimeMs = Date.now() - searchStarted;
        persist(e.phase !== "WORK_PROGRESS");
      },
    });
    state.state = "PUBLISHING";
    persist(true);
    publishGeneration(config.instanceRoot, id, {
      generationsRoot: config.generationsRoot,
      activePointerPath: config.activeGenerationPath,
    });
    state.state = "READY";
    state.running = false;
    state.finishedAtMs = Date.now();
    state.restartRequired = id !== previous;
    persist(true);
    const final = {
      generationId: id,
      state: "READY",
      catalog: result.catalogFacts,
      search: result.searchFacts,
      build: report,
      elapsedMs: state.elapsedMs,
      searchTimeMs,
      peakMemory: state.peakMemory,
      sourceWriteAttempts: guard.blockedCount(),
    };
    writeJson(path.join(config.reportsRoot, id + ".json"), final);
    return final;
  } catch (e) {
    state.state = "FAILED";
    state.running = false;
    state.failure = { code: safeCode(e) };
    state.finishedAtMs = Date.now();
    persist(true);
    writeJson(path.join(config.reportsRoot, id + ".json"), {
      generationId: id,
      state: "FAILED",
      build: report,
      failure: state.failure,
      sourceWriteAttempts: guard?.blockedCount() || 0,
    });
    throw e;
  } finally {
    guard?.restore();
    await owner.release();
  }
}
module.exports = { fullScan, safeCode };
