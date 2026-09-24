"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { readJson, writeJson } = require("../instance/files.js");
const { acquireOwnership, processIdentity, sameIdentity } = require("../instance/ownership.js");
const { inside, noLinks } = require("../library/io-paths.js");
const { GENERATION_ID_PATTERN } = require("./generations.js");
function databaseFilesIdle(root) {
  if (process.platform !== "win32") return false;
  const encoded = Buffer.from(root, "utf8").toString("base64");
  const script = "$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); try { Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Name -match '\\.sqlite(?:-wal|-shm|-journal)?$' } | ForEach-Object { $f=[IO.File]::Open($_.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); $f.Dispose() }; exit 0 } catch { exit 1 }";
  return require("node:child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", timeout: 15000 }).status === 0;
}
// Serialized with Runtime startup and publication. Never guess around uncertain ownership.
async function withMaintenance(config, action) {
  const owner = await acquireOwnership(config, "maintenance");
  try { return await action(); } finally { await owner.release(); }
}
function processState(lock, identify) {
  if (!lock) return "absent";
  if (!lock.identity) return "unknown";
  try { return sameIdentity(identify(lock.identity.pid), lock.identity) ? "live" : "dead"; }
  catch { return "unknown"; }
}
function retentionPlan(config, { nowMs = Date.now(), identify = processIdentity } = {}) {
  const pointer = readJson(config.activeGenerationPath);
  const runtime = readJson(config.statusPath), scan = readJson(config.scanStatusPath);
  const runtimeState = processState(readJson(path.join(config.stateRoot, "runtime.lock")), identify);
  const scanState = processState(readJson(path.join(config.stateRoot, "scan.lock")), identify);
  const protectedIds = new Set([pointer?.generationId, pointer?.previousGenerationId]);
  if (["live", "unknown"].includes(runtimeState)) protectedIds.add(runtime?.loadedGenerationId);
  if (["live", "unknown"].includes(scanState)) protectedIds.add(scan?.generationId);
  const uncertain = !pointer?.generationId || runtimeState === "unknown" || scanState === "unknown" ||
    (runtimeState === "live" && !runtime?.loadedGenerationId) || (scanState === "live" && !scan?.generationId);
  noLinks(config.generationsRoot);
  const entries = fs.readdirSync(config.generationsRoot, { withFileTypes: true }).map((entry) => {
    const id = entry.name, root = path.join(config.generationsRoot, id);
    let manifest = null;
    try { noLinks(root); if (entry.isDirectory() && GENERATION_ID_PATTERN.test(id)) manifest = readJson(path.join(root, "manifest.json")); } catch {}
    if (!manifest || manifest.generationId !== id || !["BUILDING", "VALIDATED", "READY", "FAILED"].includes(manifest.state))
      return { id, action: "RETAIN", reason: "unknown", state: "UNKNOWN" };
    return { id, state: manifest.state, createdAtMs: manifest.readyAtMs || manifest.createdAtMs, pinned: manifest.pinned === true };
  });
  const previous = entries.filter((e) => e.state === "READY" && e.id !== pointer?.generationId)
    .sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.id < b.id ? -1 : 1))[0];
  if (previous) protectedIds.add(previous.id);
  return entries.map((e) => {
    if (e.action) return e;
    if (uncertain || protectedIds.has(e.id) || e.pinned || !config.retention.enabled)
      return { ...e, action: "RETAIN", reason: uncertain ? "ownership_uncertain" : "referenced_or_previous" };
    if (!Number.isFinite(e.createdAtMs) || nowMs - e.createdAtMs < config.retention.staleAfterMs)
      return { ...e, action: "RETAIN", reason: "recent" };
    return { ...e, action: "DELETE", reason: e.state === "READY" ? "superseded_unreferenced" : "abandoned_unreferenced" };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function treeBytes(root) {
  noLinks(root);
  let bytes = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, e.name); noLinks(target);
    const s = fs.lstatSync(target);
    if (s.isDirectory()) bytes += treeBytes(target);
    else if (s.isFile()) bytes += s.size;
    else throw Object.assign(new Error("Special generation entry"), { code: "RETENTION_SPECIAL_ENTRY" });
  }
  return bytes;
}
// Caller holds maintenance lease; sources and publication paths are already validated.
function retainGenerationsLocked(config, options = {}) {
  const plan = retentionPlan(config, options), removed = [];
  for (const item of plan.filter((e) => e.action === "DELETE")) {
    if (!GENERATION_ID_PATTERN.test(item.id)) throw new Error("Invalid retention identity");
    const root = path.resolve(config.generationsRoot, item.id);
    if (!inside(config.generationsRoot, root) || root === config.generationsRoot) throw new Error("Retention path escape");
    const bytes = treeBytes(root);
    if (!databaseFilesIdle(root)) { item.action = "RETAIN"; item.reason = "file_in_use_or_unverifiable"; continue; }
    const retired = path.join(config.tempRoot, "retired-generation-" + crypto.randomUUID());
    noLinks(retired);
    // Atomic detach first. On Windows an externally opened DB prevents rename/delete;
    // preserve it and report rather than attempting forced handle/process closure.
    try {
      fs.renameSync(root, retired);
      try { fs.rmSync(retired, { recursive: true }); }
      catch (error) { if (!fs.existsSync(root)) fs.renameSync(retired, root); throw error; }
      removed.push({ id: item.id, state: item.state, bytes, reason: item.reason });
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      item.action = "RETAIN"; item.reason = "file_in_use";
    }
  }
  const report = { atMs: Date.now(), plan, removed, bytes: removed.reduce((n, e) => n + e.bytes, 0) };
  writeJson(path.join(config.reportsRoot, "retention.json"), report);
  return report;
}
async function retainGenerations(config, options) { return withMaintenance(config, () => retainGenerationsLocked(config, options)); }
module.exports = { withMaintenance, retentionPlan, retainGenerationsLocked, retainGenerations };
