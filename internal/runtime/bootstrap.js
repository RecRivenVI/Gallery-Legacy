"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
const {
  normalizeRuntimeConfig,
  ensureLayout,
} = require("../instance/config.js");
const { readJson, writeJson } = require("../instance/files.js");
const {
  acquireOwnership,
  processIdentity,
  processIdentityAsync,
  sameIdentity,
} = require("../instance/ownership.js");
const { resolveActiveGeneration } = require("../publication/generations.js");
const { createRuntimeServer } = require("../server/http.js");
const { withMaintenance } = require("../publication/retention.js");
function createRuntimeBootstrap({ config: input, onShutdownRequest = null, sourceWriteAttempts = () => 0, lookupIdentity = processIdentityAsync }) {
  const config = normalizeRuntimeConfig(input);
  let owner = null,
    server = null,
    scanChild = null,
    closed = false,
    closePromise = null,
    managerIdentity = null,
    managerCheckedAt = 0,
    managerChecking = false,
    scanChecking = false,
    checkedScanIdentity = null;
  let applyTimer = null, applying = null, nextApplyAt = 0;
  const state = {
    instanceId: config.instanceId,
    deployment: config.deployment,
    liveUpdates: config.liveUpdates,
    state: "STOPPED",
    pid: process.pid,
    managerPid: null,
    loadedGenerationId: null,
    startedAtMs: null,
  };
  let checkedAt = 0,
    scanVerified = null;
  function persist() {
    writeJson(config.statusPath, { ...state, updatedAtMs: Date.now() });
  }
  function status() {
    if (!closed && managerIdentity && !managerChecking && Date.now() - managerCheckedAt > 5000) {
      managerCheckedAt = Date.now();
      managerChecking = true;
      const expected=managerIdentity;
      Promise.resolve().then(()=>lookupIdentity(expected.pid)).then(actual=>{
        if (!closed && managerIdentity === expected && !sameIdentity(actual, expected)) {
          managerIdentity = null; state.managerPid = null; persist();
        }
      }).catch(()=>{}).finally(()=>{managerChecking=false;});
    }
    let pointer = null,
      scan = null;
    try {
      pointer = readJson(config.activeGenerationPath);
      scan = readJson(config.scanStatusPath);
    } catch {}
    if (scan?.running) {
      if (!sameIdentity(checkedScanIdentity,scan.identity)) {scanVerified=null;checkedAt=0;}
      if (!closed && !scanChecking && Date.now() - checkedAt > 5000) {
        checkedAt = Date.now();
        const expected=scan.identity;
        checkedScanIdentity=expected;scanChecking=true;
        Promise.resolve().then(()=>lookupIdentity(scan.pid)).then(actual=>{
          if(!closed && checkedScanIdentity === expected)scanVerified=sameIdentity(actual,expected);
        }).catch(()=>{scanVerified=null;}).finally(()=>{scanChecking=false;});
      }
      if (scanVerified === false)
        scan = {
          ...scan,
          state: "FAILED",
          running: false,
          failure: { code: "SCAN_OWNER_EXITED" },
        };
    }
    const sanitized = scan
      ? Object.fromEntries(
          [
            "state",
            "running",
            "pid",
            "generationId",
            "startedAtMs",
            "finishedAtMs",
            "elapsedMs",
            "currentPlatform",
            "activePlatforms",
            "observedWorks",
            "indexedWorks",
            "actualMedia",
            "metadataStates",
            "diagnosticCount",
            "throughput",
            "memory",
            "peakMemory",
            "platforms",
            "failure",
            "mode",
            "effectiveMode",
            "changes",
            "phase",
            "stage",
            "stageStartedAtMs",
            "stageDurationsMs",
            "search",
            "restartRequired",
            "invalidatedPlatformIds",
          ].map((k) => [k, scan[k]]),
        )
      : { state: "IDLE", running: false };
    if (scan?.scope) sanitized.scope = {
      platformId: scan.scope.platformId || scan.scope.requestedPlatformId || null,
      platformIds: scan.scope.platformIds || scan.scope.requestedPlatformIds || null,
      authorScoped: !!(scan.scope.authorDirectoryName || scan.scope.requestedAuthorDirectoryName),
      invalidatedPlatformIds: scan.scope.invalidatedPlatformIds || [],
      effectivePlatformIds: scan.scope.effectivePlatformIds || [],
    };
    const generations = [];
    if (fs.existsSync(config.generationsRoot))
      for (const id of fs.readdirSync(config.generationsRoot)) {
        try {
          const m = readJson(
            path.join(config.generationsRoot, id, "manifest.json"),
          );
          if (m)
            generations.push({
              id: m.generationId,
              state: m.state,
              works: m.catalog?.workCount ?? null,
              createdAtMs: m.createdAtMs,
            });
        } catch {}
      }
    const live = server?.liveState?.();
    const loaded = live?.baseGenerationId || state.loadedGenerationId;
    return {
      ...state,
      loadedGenerationId: loaded,
      libraryReady: loaded !== null,
      ...(live ? {live:{...live,enabled:true}} : {}),
      memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
      sourceWriteAttempts: sourceWriteAttempts(),
      activeGenerationId: pointer?.generationId || null,
      restartRequired:
        !!pointer && pointer.generationId !== loaded,
      scan: sanitized,
      generations,
    };
  }
  async function scan() {
    return require("./management.js").startFullScan(config, path.join(config.instanceRoot, "config.json"));
  }
  function applyPublished() {
    if (closed || !server || applying || Date.now() < nextApplyAt) return applying;
    let pointer, scan;
    try { pointer = readJson(config.activeGenerationPath); scan = readJson(config.scanStatusPath); } catch { return; }
    const loaded = server.liveState()?.baseGenerationId || state.loadedGenerationId;
    if (!pointer?.generationId || pointer.generationId === loaded || scan?.running) return;
    applying = withMaintenance(config, async () => {
      state.applyingGeneration = true;
      const generation = await require("./generation-check.js").checkGeneration(config);
      if (closed) return;
      if (readJson(config.activeGenerationPath)?.generationId !== generation.generationId) throw Object.assign(new Error("Published generation changed during validation"), { code: "GENERATION_APPLY_STALE" });
      if (config.liveUpdates) {
        if (server.liveState()) throw Object.assign(new Error("Live checkpoint recovery required"), { code: "LIVE_RESTART_REQUIRED" });
        // The first completed scan prepares live before releasing its owner.
        // Never replace an already-open live database here.
      }
      server.applyGeneration(generation);
      state.loadedGenerationId = generation.generationId;
      state.applyError = null;
      persist();
    }).catch(error => {
      state.applyError = { code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "GENERATION_APPLY_FAILED" };
      nextApplyAt = Date.now() + 30000;
    }).finally(() => { state.applyingGeneration = false; applying = null; });
    return applying;
  }
  async function start() {
    ensureLayout(config);
    owner = await acquireOwnership(config, "runtime", async (request) => {
      if (request.operation === "status") return { ...(server ? server.snapshotState() : status()), localControl: true };
      if (request.operation === "access.read") return server.access.snapshot();
      if (request.operation === "access.clear") return server.access.clear();
      if (request.operation === "access.block") return server.access.block(request.id, request.blocked);
      if (request.operation === "manager") { manager(request.pid || null); return { accepted: true }; }
      if (request.operation === "scan") {
        if (request.confirmReadOnly !== true) throw Object.assign(new Error("Confirmation required"), { code: "READ_ONLY_CONFIRMATION_REQUIRED" });
        await scan(); return { accepted: true };
      }
      if (request.operation === "stop") {
        setTimeout(() => void (onShutdownRequest ? onShutdownRequest() : close()), 50);
        return { accepted: true };
      }
      throw Object.assign(new Error("Unsupported control"), { code: "CONTROL_OPERATION_INVALID" });
    });
    let previous = null;
    try {
      previous = readJson(config.statusPath);
    } catch {}
    state.state = "STARTING";
    state.recovered = owner.recovered || previous?.state === "READY";
    state.startedAtMs = Date.now();
    persist();
    try {
      const generation = await withMaintenance(config, () => {
        if (!fs.existsSync(config.activeGenerationPath)) {
          const ready = fs.readdirSync(config.generationsRoot).some(id => readJson(path.join(config.generationsRoot, id, "manifest.json"))?.state === "READY");
          if (ready) throw Object.assign(new Error("Published pointer is missing"), { code: "GENERATION_ACTIVE_POINTER_MISSING" });
          return null;
        }
        const resolved = resolveActiveGeneration(config.instanceRoot, {
          generationsRoot: config.generationsRoot,
          activePointerPath: config.activeGenerationPath,
        });
        state.loadedGenerationId = resolved.generationId;
        persist();
        return resolved;
      });
      if(config.liveUpdates && generation)await require("../catalog/live.js").ensureLive(config,generation);
      server = createRuntimeServer({
        config,
        generation,
        status,
        onScan: scan,
      });
      await server.start();
      state.state = "READY";
      persist();
      applyTimer = setInterval(() => void applyPublished(), 1500);
      applyTimer.unref();
      return { url: config.url, generationId: generation?.generationId || null };
    } catch (error) {
      state.state = "FAILED";
      state.error = { code: error.code || "START_FAILED" };
      persist();
      if (server) await server.close();
      await owner.release();
      owner = null;
      throw error;
    }
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      clearInterval(applyTimer);
      await applying;
      state.state = "STOPPING";
      persist();
      if (server) await server.close();
      state.state = "STOPPED";
      state.managerPid = null;
      persist();
      if (owner) await owner.release();
      owner = null;
      closed = true;
    })();
    return closePromise;
  }
  function manager(pid) {
    managerIdentity = pid ? processIdentity(pid) : null;
    state.managerPid = managerIdentity?.pid || null;
    managerCheckedAt = Date.now();
    persist();
  }
  return { config, start, close, status, scan, manager, applyPublished };
}
module.exports = { createRuntimeBootstrap };
