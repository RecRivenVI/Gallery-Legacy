"use strict";
const { writeJson } = require("../instance/files.js");
// Progress is replaceable telemetry, not publication authority. Coalesce it and
// retry transient Windows sharing errors without aborting a valid Catalog batch.
function createProgressWriter(file, { write = writeJson, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let pending = null, running = null, lastError = null, retries = 0;
  function save(snapshot, attempt = 0) {
    // The ordinary write is synchronous: make a stage boundary visible before
    // entering a long native SQLite operation. Only sharing-error backoff yields.
    try { write(file, snapshot); lastError = null; return null; }
    catch (error) {
      lastError = error;
      if (!["EPERM","EBUSY","EACCES"].includes(error.code) || attempt === 3) return null;
      retries++;
      return delay(50 * (attempt + 1)).then(() => {
        if (pending) { snapshot = pending; pending = null; }
        return save(snapshot, attempt + 1);
      });
    }
  }
  function start() {
    if (running) return;
    while (pending) {
      const snapshot = pending; pending = null;
      const retry = save(snapshot);
      if (retry) { running = retry.finally(() => { running = null; start(); }); return; }
    }
  }
  return {
    enqueue(state) { pending = JSON.parse(JSON.stringify(state)); start(); },
    async flush() { while (running) await running; if (lastError) throw Object.assign(new Error("Scan progress could not be saved"), { code: "SCAN_STATUS_WRITE_FAILED", cause: lastError }); },
    stats: () => ({ retries, pending: !!pending || !!running, osCode: lastError?.code || null }),
  };
}
module.exports = { createProgressWriter };
