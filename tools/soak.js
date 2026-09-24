"use strict";
// A bounded, aggregate-only staging observation process. Does not scan, publish,
// stop Runtime, download full media or write into source/generation directories.
const path = require("node:path");
const { readRuntimeConfig, ensureLayout } = require("../internal/instance/config.js");
const { acquireOwnership } = require("../internal/instance/ownership.js");
const { writeJson } = require("../internal/instance/files.js");
async function main() {
  const args = process.argv.slice(2), at = args.indexOf("--config");
  if (at < 0 || !args.includes("--confirm-private-read-only")) throw new Error("SOAK_CONFIRMATION_REQUIRED");
  const config = readRuntimeConfig(path.resolve(args[at + 1]));
  ensureLayout(config);
  process.env.TEMP = config.tempRoot; process.env.TMP = config.tempRoot;
  process.env.PSModuleAnalysisCachePath = path.join(config.tempRoot, "powershell-module-cache");
  const owner = await acquireOwnership(config, "soak");
  const guard = require("../internal/library/write-guard.js").installWriteGuard({ instanceRoot: config.instanceRoot, protectedRoots: config.protectedRoots });
  const startedAtMs = Date.now(), result = {
    state: "RUNNING", pid: process.pid, startedAtMs, eligibleAtMs: startedAtMs + 86400000,
    lastCheckAtMs: null, checks: 0, failures: 0, recentFailures: [], peakRss: 0, peakHeap: 0,
    runtimePid: null, runtimeStartedAtMs: null, generationId: null, sourceWriteAttempts: 0, restarts: 0, maxCheckGapMs: 0,
    privacy: { screenshots: 0, recordings: 0, contentInReport: false },
  };
  let stopped = false;
  const file = path.join(config.reportsRoot, "soak.json");
  async function json(resource) {
    const response = await fetch(config.url + "/api/v1/" + resource, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("HTTP_" + response.status);
    const body = await response.json();
    if (body.protocolVersion !== 1 || !body.data) throw new Error("PROTOCOL_MISMATCH");
    return body;
  }
  async function sample() {
    try {
      const body = await json("status"), status = body.data;
      if (status.instanceId !== config.instanceId || status.state !== "READY") throw new Error("INSTANCE_NOT_READY");
      if (result.runtimePid && (result.runtimePid !== status.pid || result.runtimeStartedAtMs !== status.startedAtMs)) result.restarts++;
      if (result.generationId && result.generationId !== body.generationId) throw new Error("GENERATION_CHANGED");
      result.runtimePid = status.pid; result.runtimeStartedAtMs = status.startedAtMs; result.generationId = body.generationId;
      result.peakRss = Math.max(result.peakRss, status.memory?.rss || 0);
      result.peakHeap = Math.max(result.peakHeap, status.memory?.heapUsed || 0);
      result.sourceWriteAttempts = Math.max(result.sourceWriteAttempts, status.sourceWriteAttempts || 0);
      if (result.sourceWriteAttempts) throw new Error("SOURCE_WRITE_BLOCKED");
      const query = ["works?pageSize=1", "works?mediaType=image&pageSize=1", "works?mediaType=video&pageSize=1", "works?q=R&pageSize=1", "tags?pageSize=1", "authors?pageSize=1"][result.checks % 6];
      const response = await json(query);
      if (!Array.isArray(response.data.items)) throw new Error("INVALID_PAGE");
      result.checks++;
      if (result.lastCheckAtMs) result.maxCheckGapMs = Math.max(result.maxCheckGapMs, Date.now() - result.lastCheckAtMs);
      if (Date.now() >= result.eligibleAtMs && result.checks >= 1440 && result.failures === 0 && result.restarts === 0 && result.maxCheckGapMs < 180000) result.state = "24H_OBSERVED";
    } catch (error) {
      result.failures++;
      result.recentFailures.push({ atMs: Date.now(), code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CHECK_FAILED" });
      result.recentFailures = result.recentFailures.slice(-20);
      result.state = "DEGRADED";
    }
    result.lastCheckAtMs = Date.now(); result.elapsedMs = result.lastCheckAtMs - startedAtMs;
    result.soakSourceWriteAttempts = guard.blockedCount();
    writeJson(file, result);
  }
  async function shutdown() {
    if (stopped) return; stopped = true; clearInterval(timer);
    result.state = "STOPPED"; writeJson(file, result); await owner.release(); guard.restore(); process.exit(0);
  }
  let busy = false;
  await sample();
  const timer = setInterval(async () => { if (busy || stopped) return; busy = true; try { await sample(); } finally { busy = false; } }, 60000);
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  console.log(JSON.stringify({ state: result.state, startedAtMs, eligibleAtMs: result.eligibleAtMs, pid: process.pid, port: config.port, generationId: result.generationId }));
}
main().catch((error) => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : "SOAK_FAILED"); process.exitCode = 1; });
