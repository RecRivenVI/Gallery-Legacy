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
  sameIdentity,
} = require("../instance/ownership.js");
const { resolveActiveGeneration } = require("../publication/generations.js");
const { createRuntimeServer } = require("../server/http.js");
function createRuntimeBootstrap({ config: input }) {
  const config = normalizeRuntimeConfig(input);
  let owner = null,
    server = null,
    scanChild = null,
    closed = false,
    closePromise = null;
  const state = {
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
    let pointer = null,
      scan = null;
    try {
      pointer = readJson(config.activeGenerationPath);
      scan = readJson(config.scanStatusPath);
    } catch {}
    if (scan?.running) {
      if (Date.now() - checkedAt > 5000) {
        checkedAt = Date.now();
        try {
          scanVerified = sameIdentity(processIdentity(scan.pid), scan.identity);
        } catch {
          scanVerified = null;
        }
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
          ].map((k) => [k, scan[k]]),
        )
      : { state: "IDLE", running: false };
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
    return {
      ...state,
      activeGenerationId: pointer?.generationId || null,
      restartRequired:
        !!pointer && pointer.generationId !== state.loadedGenerationId,
      scan: sanitized,
      generations,
    };
  }
  async function scan() {
    const current = status().scan;
    if (scanChild || current.running)
      throw Object.assign(new Error("Scan already running"), {
        code: "SCAN_IN_USE",
        status: 409,
      });
    const configPath = path.join(config.instanceRoot, "config.json");
    if (!fs.existsSync(configPath))
      throw Object.assign(
        new Error("Persist instance configuration before scanning"),
        { code: "CONFIG_REQUIRED", status: 409 },
      );
    scanChild = cp.spawn(
      process.execPath,
      [
        path.resolve(__dirname, "../../cmd/gallery/main.js"),
        "scan",
        "--config",
        configPath,
        "--confirm-read-only",
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env: { ...process.env, TEMP: config.tempRoot, TMP: config.tempRoot },
      },
    );
    scanChild.once("error", () => {
      scanChild = null;
    });
    scanChild.once("exit", () => {
      scanChild = null;
      checkedAt = 0;
    });
  }
  async function start() {
    ensureLayout(config);
    owner = await acquireOwnership(config, "runtime");
    let previous = null;
    try {
      previous = readJson(config.statusPath);
    } catch {}
    state.state = "STARTING";
    state.recovered = owner.recovered || previous?.state === "READY";
    state.startedAtMs = Date.now();
    persist();
    try {
      const generation = resolveActiveGeneration(config.instanceRoot, {
        generationsRoot: config.generationsRoot,
        activePointerPath: config.activeGenerationPath,
      });
      state.loadedGenerationId = generation.generationId;
      server = createRuntimeServer({
        config,
        generation,
        status,
        onScan: scan,
      });
      await server.start();
      state.state = "READY";
      persist();
      return { url: config.url, generationId: generation.generationId };
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
    state.managerPid = pid;
    persist();
  }
  return { config, start, close, status, scan, manager };
}
module.exports = { createRuntimeBootstrap };
