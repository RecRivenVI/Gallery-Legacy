"use strict";

// Worker boundary: this module accepts only structured-cloneable observation
// facts and returns pure preparation facts. It must never acquire filesystem,
// database, network, or process resources.
const { parentPort } = require("node:worker_threads");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");
const { mapPreparedEntry, prepareMetadataEntry } = require("./prepare.js");

const BLOCKED_IO_MODULES = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises",
  "net", "node:net", "http", "node:http", "https", "node:https",
  "dgram", "node:dgram", "dns", "node:dns", "dns/promises", "node:dns/promises",
  "tls", "node:tls", "child_process", "node:child_process",
  "better-sqlite3", "ws",
]);
const originalLoad = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  if (BLOCKED_IO_MODULES.has(request))
    throw Object.assign(new Error("Preparation worker I/O is forbidden"), {
      code: "PREPARATION_IO_FORBIDDEN",
    });
  return originalLoad.call(this, request, parent, isMain);
};
const denyNetwork = () => {
  throw Object.assign(new Error("Preparation worker I/O is forbidden"), {
    code: "PREPARATION_IO_FORBIDDEN",
  });
};
globalThis.fetch = denyNetwork;
if (globalThis.WebSocket) globalThis.WebSocket = denyNetwork;

if (!parentPort) throw new Error("Preparation worker requires parentPort");

function serializeError(error) {
  const code = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || ""))
    ? String(error.code)
    : "PREPARATION_WORKER_FAILED";
  return {
    code,
    message:
      code === "PREPARATION_IO_FORBIDDEN"
        ? "Preparation worker I/O is forbidden"
        : code === "PREPARATION_OPERATION_INVALID"
          ? "Invalid preparation operation"
          : "Preparation worker failed",
  };
}

parentPort.on("message", (message) => {
  if (!message || typeof message.id !== "number") return;
  const startedAt = performance.now();
  try {
    let value;
    if (message.operation === "prepare") {
      value = prepareMetadataEntry(message.work);
    } else if (message.operation === "prepareMapped") {
      value = mapPreparedEntry(
        prepareMetadataEntry(message.work),
        message.author,
        message.selections,
      );
    } else if (message.operation === "map") {
      value = mapPreparedEntry(
        message.entry,
        message.author,
        message.selections,
      );
    } else if (message.operation === "__test_io") {
      require("node:fs").readFileSync(".");
    } else {
      throw Object.assign(new Error("Unknown preparation operation"), {
        code: "PREPARATION_OPERATION_INVALID",
      });
    }
    const operationMs = Math.max(0, performance.now() - startedAt);
    const heapUsed = process.memoryUsage().heapUsed;
    parentPort.postMessage({
      type: "result",
      id: message.id,
      value,
      telemetry: { operationMs, heapUsed },
    });
  } catch (error) {
    parentPort.postMessage({ type: "error", id: message.id, error: serializeError(error) });
  }
});
