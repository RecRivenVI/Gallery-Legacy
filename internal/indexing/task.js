"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const {
  buildGeneration,
  publishGeneration,
  resolveActiveGeneration,
} = require("../publication/generations.js");
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { selectAuthorDisplayName, selectSourceIdentities } = require("../library/identity.js");
const { ensureLayout } = require("../instance/config.js");
const { acquireOwnership } = require("../instance/ownership.js");
const { readJson, writeJson } = require("../instance/files.js");
const { installWriteGuard } = require("../library/write-guard.js");
const { withMaintenance, retainGenerationsLocked } = require("../publication/retention.js");
const { applyLiveBatch, checkpointLive, ensureLive, openLive } = require("../catalog/live.js");
function safeCode(error) {
  const c = String(error?.code || "BUILD_FAILED");
  return /^[a-zA-Z0-9_]{1,64}$/.test(c) ? c : "BUILD_FAILED";
}
function aggregate(report) {
  return {
    state: report.state,
    global: report.global,
    counts: report.catalogCounts,
    changes: report.changes || null,
    scope: report.scope || null,
    execution: report.execution || null,
    platforms: report.platforms.map((p) => ({
      platformId: p.platformId,
      status: p.status,
      filesystemIndexing: p.filesystemIndexing,
      metadataEnrichment: p.metadataEnrichment,
      authors: p.observation?.authorsObserved || 0,
      works: p.observation?.worksObserved ?? p.preparation?.preparedWorks ?? 0,
      worksRebuilt: p.worksRebuilt || 0,
      worksReused: p.worksReused || 0,
      storage: p.storage || null,
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
  { confirmReadOnly = false, generationId = null, io = null, mode = "full", platformId = null, platformIds = null, authorDirectoryName = null, beforeBaselineValidation = null } = {},
) {
  if (confirmReadOnly !== true)
    throw Object.assign(new Error("Read-only source confirmation required"), {
      code: "READ_ONLY_CONFIRMATION_REQUIRED",
    });
  if (!["full", "incremental"].includes(mode))
    throw Object.assign(new Error("Scan mode must be full or incremental"), { code: "SCAN_MODE_INVALID" });
  const selectedPlatforms = require("./scope.js").scanPlatforms({ platformId, platformIds });
  if (authorDirectoryName !== null && selectedPlatforms?.length === 1) platformId = selectedPlatforms[0];
  if (authorDirectoryName !== null) {
    if (!platformId) throw Object.assign(new Error("Author scope requires a platform"), { code: "SCAN_AUTHOR_PLATFORM_REQUIRED" });
    if (typeof authorDirectoryName !== "string" || !authorDirectoryName || /[\\/]/.test(authorDirectoryName))
      throw Object.assign(new Error("Author scope must be one directory name"), { code: "SCAN_AUTHOR_INVALID" });
    try {
      const normalized = normalizeRelativePath(authorDirectoryName);
      if (normalized.relativePath === "." || normalized.relativePath === "..") throw new Error("invalid");
    } catch {
      throw Object.assign(new Error("Author scope must be one safe directory name"), { code: "SCAN_AUTHOR_INVALID" });
    }
  }
  ensureLayout(config);
  const owner = await acquireOwnership(config, "scan");
  const id = generationId || "scan-" + new Date().toISOString().replace(/[^0-9]/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const startedAtMs = Date.now();
  let previous = null;
  let baseline = null, effectiveMode = mode, fallbackToFull = false;
  const state = {
    protocolVersion: 1,
    state: "PREPARING",
    running: true,
    pid: process.pid,
    identity: owner.identity,
    generationId: id,
    startedAtMs,
    finishedAtMs: null,
    elapsedMs: 0,
    currentPlatform: null,
    activePlatforms: [],
    observedWorks: 0,
    indexedWorks: 0,
    actualMedia: 0,
    metadataStates: {},
    diagnosticCount: 0,
    throughput: 0,
    memory: {},
    peakMemory: { rss: 0, heapUsed: 0 },
    platforms: [],
    activeGenerationBefore: null,
    restartRequired: false,
    mode,
    effectiveMode,
    scope: { platformId, platformIds: selectedPlatforms, authorDirectoryName },
    failure: null,
    stage: "preparing",
    stageStartedAtMs: startedAtMs,
    stageDurationsMs: {},
  };
  function stage(next) {
    if (state.stage === next) return;
    const at = Date.now();
    state.stageDurationsMs[state.stage] = (state.stageDurationsMs[state.stage] || 0) + at - state.stageStartedAtMs;
    state.stage = next; state.stageStartedAtMs = at;
  }
  const platforms = new Map();
  const progressWriter = require("./progress.js").createProgressWriter(config.scanStatusPath);
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
    state.progressPersistence = progressWriter.stats();
    progressWriter.enqueue(state);
  }
  let guard = null;
  let live = null;
  let sourceWriteAttempts = 0;
  let resourcesReleased = false;
  async function releaseScanResources() {
    if (resourcesReleased) return;
    if (guard) {
      sourceWriteAttempts += guard.blockedCount();
      guard.restore();
      guard = null;
    }
    try {
      live?.close();
    } finally {
      live = null;
      await owner.release();
      resourcesReleased = true;
    }
  }
  const checkCancelled = require("./cancellation.js").createCancellationCheck({generationId:id,read:()=>readJson(path.join(config.stateRoot,"scan-cancel.json"))});
  try {
    persist(true);
    await progressWriter.flush();
    if (beforeBaselineValidation) await beforeBaselineValidation();
    const runtimeState = readJson(config.statusPath);
    if (runtimeState?.state === "READY" && Boolean(runtimeState.liveUpdates) !== Boolean(config.liveUpdates))
      throw Object.assign(new Error("Runtime must restart before changing live update mode"), { code: "LIVE_MODE_RESTART_REQUIRED" });
    previous = readJson(config.activeGenerationPath)?.generationId || null;
    if (previous) baseline = resolveActiveGeneration(config.instanceRoot, {
      generationsRoot: config.generationsRoot,
      activePointerPath: config.activeGenerationPath,
    });
    if (!baseline && ((selectedPlatforms && selectedPlatforms.length !== PLATFORM_REGISTRY.length) || authorDirectoryName))
      throw Object.assign(new Error("A partial scan requires an active READY baseline"), { code: "SCAN_BASELINE_REQUIRED" });
    if (!baseline && mode === "incremental") { effectiveMode = "full"; fallbackToFull = true; }
    state.activeGenerationBefore = previous;
    state.effectiveMode = effectiveMode;
    if (baseline && config.liveUpdates) {
      await ensureLive(config, baseline);
      live = await openLive(config, baseline, { readonly: false });
      const checkpoint = live.db.pragma("wal_checkpoint(FULL)")[0];
      if (checkpoint.busy !== 0n)
        throw Object.assign(new Error("Live Catalog could not be checkpointed for candidate snapshot"), { code: "LIVE_SNAPSHOT_BUSY" });
      state.live = { epoch: live.epoch, revision: live.revision, baseGenerationId: live.baseGenerationId };
    }
    state.state = "SCANNING";
    stage("catalog");
    persist(true);
    guard = installWriteGuard({
      instanceRoot: config.instanceRoot,
      protectedRoots: config.protectedRoots,
    });
    const result = await buildGeneration({
      checkCancelled,
      instanceRoot: config.instanceRoot,
      generationsRoot: config.generationsRoot,
      generationId: id,
      requireCompleteCatalog: true,
      searchOptions: { baselineSearchPath: effectiveMode === "incremental" ? baseline?.searchIndexPath || null : null },
      catalogOptions: {
        platformRoots: config.sources,
        batchSize: 500,
        nestedSampleLimit: 32,
        io,
        baseCatalogPath: baseline && (mode === "incremental" || selectedPlatforms) ? (live?.catalogPath || baseline.catalogPath) : null,
        mode: effectiveMode,
        platformId: platformIds === null ? platformId : null,
        platformIds,
        authorDirectoryName,
        onCommittedBatch: live ? ({ mappedCandidates, completeAuthors = [] }) => {
          const completeAuthorKeys = new Set(completeAuthors.map((row) => row.platform_id + "\0" + row.relative_path_key));
          const complete = mappedCandidates.filter((candidate) => candidate.rows.work.filesystem_state === "present" && candidate.rows.work.filesystem_files_state === "complete").map((candidate) => {
            const author = candidate.rows.author, key = author.platform_id + "\0" + author.relative_path_key;
            if (candidate.authorAuthorityFinal !== true || completeAuthorKeys.has(key)) return candidate;
            const context = { platformId: author.platform_id, authorDirectoryName: author.folder_name, workDirectoryName: null };
            const identity = selectSourceIdentities(null,context), display = selectAuthorDisplayName(null,context);
            return { ...candidate, authorAuthorityFinal: false, liveProvisionalAuthor: true, rows: { ...candidate.rows,
              author: { ...author, source_author_id: identity.sourceAuthorId, source_author_id_source: identity.sourceAuthorIdSource,
                display_name: display.value, display_name_source: display.source, handle: null, name_rank: null, profile_state: "unavailable" },
              authorProfile: null, authorAliases: [] } };
          });
          if (!complete.length && !completeAuthors.length) return;
          const result = applyLiveBatch(live.db, { mappedCandidates: complete, preparedAuthors: completeAuthors, observedAtMs: Date.now() });
          state.live = { epoch: result.epoch, revision: result.revision, baseGenerationId: result.baseGenerationId };
          persist(false);
        } : null,
      },
      onCatalogReport: (value) => {
        report = aggregate(value);
        state.changes = report.changes;
        state.scope = report.scope;
        persist(true);
      },
      onProgress: (e) => {
        if (e.phase === "PLATFORM_START" && e.platformId && !state.activePlatforms.includes(e.platformId)) {
          state.activePlatforms.push(e.platformId);
        }
        if (e.phase === "PLATFORM_DONE" && e.platformId) {
          state.activePlatforms = state.activePlatforms.filter((id) => id !== e.platformId);
        }
        if (e.platformId) {
          const p = platforms.get(e.platformId) || { platformId: e.platformId };
          for (const k of [
            "authors",
            "observedWorks",
            "indexedWorks",
            "reusedWorks",
            "storage",
            "actualMedia",
            "metadataStates",
            "diagnostics",
            "timings",
            "status",
            "changes",
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
          if (e.changes) state.changes = e.changes;
        }
        if (e.state && e.state !== "READY") state.state = e.state;
        if (e.phase === "SEARCH_BUILD_START") searchStarted = Date.now();
        if (e.phase === "SEARCH_FINALIZE")
          searchTimeMs = Date.now() - searchStarted;
        if (e.phase) state.phase = e.phase;
        if (e.phase === "SEARCH_BUILD_START") stage("search");
        if (["CATALOG_FINALIZE", "SEARCH_FINALIZE"].includes(e.phase)) stage("validation");
        if (e.searchReport) state.search = e.searchReport;
        persist(e.phase !== "WORK_PROGRESS");
      },
    });
    sourceWriteAttempts = guard.blockedCount();
    guard.restore();
    guard = null;
    state.state = "PUBLISHING";
    stage("publication");
    checkCancelled.force();
    persist(true);
    await withMaintenance(config, () => {
      checkCancelled.force();
      const activeNow = readJson(config.activeGenerationPath)?.generationId || null;
      if (activeNow !== previous)
        throw Object.assign(new Error("Active generation changed while the candidate was building"), { code: "SCAN_BASELINE_CHANGED" });
      publishGeneration(config.instanceRoot, id, {
        generationsRoot: config.generationsRoot,
        activePointerPath: config.activeGenerationPath,
        atomicWriteHooks: {rename(from,to){checkCancelled.force();fs.renameSync(from,to);}},
      });
      if (live) {
        try {
          const checkpoint = checkpointLive(live.db, { candidateCatalogPath: result.catalogPath, scope: report?.scope || {}, baseGenerationId: id });
          state.live = { epoch: checkpoint.epoch, revision: checkpoint.revision, baseGenerationId: checkpoint.baseGenerationId };
        } catch (error) {
          // Publication is already durable. A base mismatch makes the next
          // Runtime start rebuild live from this READY generation.
          state.liveCheckpointPending = true;
          writeJson(path.join(config.reportsRoot, id + "-live-checkpoint-error.json"), { code: safeCode(error) });
        }
      }
      // Cleanup is not part of publication success; evidence is retained on failure.
      try { retainGenerationsLocked(config); }
      catch (error) { writeJson(path.join(config.reportsRoot, "retention-error.json"), { code: safeCode(error) }); }
    });
    if (!live && config.liveUpdates) {
      const initialized = await ensureLive(config, { generationId: id, catalogPath: result.catalogPath });
      state.live = { epoch: initialized.epoch, revision: initialized.revision, baseGenerationId: initialized.baseGenerationId };
    }
    state.finishedAtMs = Date.now();
    stage("complete");
    state.restartRequired = state.liveCheckpointPending === true;
    const finalElapsedMs = state.finishedAtMs - startedAtMs;
    const final = {
      generationId: id,
      state: "READY",
      catalog: result.catalogFacts,
      search: result.searchFacts,
      build: report,
      elapsedMs: finalElapsedMs,
      searchTimeMs,
      stageDurationsMs: state.stageDurationsMs,
      peakMemory: state.peakMemory,
      sourceWriteAttempts,
      mode,
      effectiveMode,
      fallbackToFull,
      scope: report?.scope || { requestedPlatformId: platformId, requestedAuthorDirectoryName: authorDirectoryName },
      changes: report?.changes || null,
      searchRebuilt: true,
      searchBuild: state.search || null,
      live: state.live || null,
      liveCheckpointPending: state.liveCheckpointPending === true,
    };
    writeJson(path.join(config.reportsRoot, id + ".json"), final);
    await releaseScanResources();
    state.state = "READY";
    state.running = false;
    state.activePlatforms = [];
    persist(true);
    await progressWriter.flush();
    return final;
  } catch (e) {
    const terminalState = e.code === "SCAN_CANCELLED" ? "CANCELLED" : "FAILED";
    const failure = { code: safeCode(e) };
    const finishedAtMs = Date.now();
    stage("failed");
    writeJson(path.join(config.reportsRoot, id + ".json"), {
      generationId: id,
      state: terminalState,
      build: report,
      failure,
      elapsedMs: finishedAtMs - startedAtMs,
      stageDurationsMs: state.stageDurationsMs,
      sourceWriteAttempts: sourceWriteAttempts + (guard?.blockedCount() || 0),
    });
    try {
      await releaseScanResources();
    } catch (releaseError) {
      releaseError.cause = releaseError.cause || e;
      throw releaseError;
    }
    state.state = terminalState;
    state.running = false;
    state.activePlatforms = [];
    state.failure = failure;
    state.finishedAtMs = finishedAtMs;
    persist(true);
    await progressWriter.flush();
    throw e;
  } finally {
    await releaseScanResources();
  }
}
module.exports = { fullScan, safeCode };
