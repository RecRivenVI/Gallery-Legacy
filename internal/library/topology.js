"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isReparse(stat) {
  return typeof stat?.isSymbolicLink === "function" && stat.isSymbolicLink();
}

function diagnostic(code, relativePath, operation, osCode = null) {
  return { code, relativePath, operation, osCode };
}

function safeLstat(target, relativePath, report, operation) {
  try { return fs.lstatSync(target, { bigint: true }); }
  catch (error) {
    report.unreadableCount++;
    report.diagnostics.push(diagnostic("entry_unreadable", relativePath, operation, error?.code || "UNKNOWN"));
    return null;
  }
}

function safeReaddir(target, relativePath, report, operation) {
  try { return fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name)); }
  catch (error) {
    report.unreadableCount++;
    report.diagnostics.push(diagnostic("directory_unreadable", relativePath, operation, error?.code || "UNKNOWN"));
    return null;
  }
}

function inspectNestedWork(work, workRelativePath, report) {
  const pending = [[work, ""]];
  while (pending.length) {
    const [directory, nestedRelative] = pending.pop();
    const entries = safeReaddir(directory, `${workRelativePath}${nestedRelative ? `\\${nestedRelative}` : ""}`, report, "nested_readdir");
    if (!entries) continue;
    for (const entry of entries) {
      const relative = nestedRelative ? `${nestedRelative}\\${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      const stat = safeLstat(fullPath, `${workRelativePath}\\${relative}`, report, "nested_lstat");
      if (!stat) continue;
      if (isReparse(stat)) {
        report.nestedReparseCount++;
        continue;
      }
      if (stat.isDirectory()) pending.push([fullPath, relative]);
      else if (!stat.isFile()) report.abnormalEntryCount++;
    }
  }
}

function preflightPlatformTopology({ platformId, physicalRoot, nestedSampleLimit = 32 } = {}) {
  if (typeof platformId !== "string" || typeof physicalRoot !== "string" || !path.isAbsolute(physicalRoot)) throw new TypeError("Topology preflight requires platformId and absolute physicalRoot");
  const started = performance.now();
  const report = {
    platformId,
    physicalRoot,
    status: "SAFE",
    rootState: "unknown",
    rootReparse: false,
    authorDirectoryCount: 0,
    authorReparseCount: 0,
    workDirectoryCount: 0,
    workReparseCount: 0,
    nestedSampledWorkCount: 0,
    nestedReparseCount: 0,
    unreadableCount: 0,
    abnormalEntryCount: 0,
    diagnostics: [],
    durationMs: 0,
  };

  const rootStat = safeLstat(physicalRoot, ".", report, "root_lstat");
  if (!rootStat) {
    report.rootState = "unreadable";
    report.status = "TOPOLOGY_BLOCKED";
    report.durationMs = performance.now() - started;
    return report;
  }
  if (isReparse(rootStat)) {
    report.rootState = "reparse";
    report.rootReparse = true;
    report.status = "TOPOLOGY_BLOCKED";
    report.durationMs = performance.now() - started;
    return report;
  }
  if (!rootStat.isDirectory()) {
    report.rootState = "not_directory";
    report.status = "TOPOLOGY_BLOCKED";
    report.durationMs = performance.now() - started;
    return report;
  }
  report.rootState = "present";
  const authors = safeReaddir(physicalRoot, ".", report, "root_readdir");
  if (!authors) {
    report.status = "TOPOLOGY_BLOCKED";
    report.durationMs = performance.now() - started;
    return report;
  }

  const sampleWorks = [];
  for (const authorEntry of authors) {
    const authorPath = path.join(physicalRoot, authorEntry.name);
    const authorStat = safeLstat(authorPath, authorEntry.name, report, "author_lstat");
    if (!authorStat) continue;
    if (isReparse(authorStat)) {
      report.authorReparseCount++;
      continue;
    }
    if (!authorStat.isDirectory()) {
      if (!authorStat.isFile()) report.abnormalEntryCount++;
      continue;
    }
    report.authorDirectoryCount++;
    const works = safeReaddir(authorPath, authorEntry.name, report, "author_readdir");
    if (!works) continue;
    for (const workEntry of works) {
      const workRelative = `${authorEntry.name}\\${workEntry.name}`;
      const workPath = path.join(authorPath, workEntry.name);
      const workStat = safeLstat(workPath, workRelative, report, "work_lstat");
      if (!workStat) continue;
      if (isReparse(workStat)) {
        report.workReparseCount++;
        continue;
      }
      if (!workStat.isDirectory()) {
        if (!workStat.isFile()) report.abnormalEntryCount++;
        continue;
      }
      report.workDirectoryCount++;
      if (sampleWorks.length < nestedSampleLimit) sampleWorks.push([workPath, workRelative]);
    }
  }

  for (const [workPath, workRelative] of sampleWorks) {
    inspectNestedWork(workPath, workRelative, report);
    report.nestedSampledWorkCount++;
  }
  if (report.authorReparseCount > 0 || report.workReparseCount > 0 || report.unreadableCount > 0) report.status = "TOPOLOGY_BLOCKED";
  report.diagnostics.sort((a, b) => compareText(a.relativePath, b.relativePath) || compareText(a.operation, b.operation));
  report.durationMs = performance.now() - started;
  return report;
}

module.exports = { preflightPlatformTopology };
