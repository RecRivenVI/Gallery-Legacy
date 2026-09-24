"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
if (!isMainThread) {
  try {
    const result = require("../publication/generations.js").resolveActiveGeneration(workerData.instanceRoot, {
      generationsRoot: workerData.generationsRoot, activePointerPath: workerData.activeGenerationPath,
    });
    parentPort.postMessage({ result });
  } catch (error) { parentPort.postMessage({ code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "GENERATION_INVALID" }); }
} else {
  // Large SQLite integrity/hash checks must not block HTTP requests.
  module.exports.checkGeneration = config => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { instanceRoot: config.instanceRoot, generationsRoot: config.generationsRoot, activeGenerationPath: config.activeGenerationPath } });
    let received = false, value;
    worker.once("message", message => { received = true; value = message; });
    worker.once("error", () => reject(Object.assign(new Error("Generation validation worker failed"), { code: "GENERATION_CHECK_FAILED" })));
    worker.once("exit", code => {
      if (code || !received || value.code) reject(Object.assign(new Error("Generation validation failed"), { code: value?.code || "GENERATION_CHECK_FAILED" }));
      else resolve(value.result);
    });
  });
}
