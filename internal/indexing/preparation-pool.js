"use strict";

const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const DEFAULT_WORKER_PATH = path.join(__dirname, "preparation-worker.js");

function errorWithCode(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function defaultWorkerCount() {
  const count = Number(os.cpus()?.length || 1);
  return Math.min(8, Math.max(1, Number.isFinite(count) ? count : 1));
}

function normalizeWorkerCount(value) {
  if (value === undefined) return defaultWorkerCount();
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("maxWorkers must be a positive safe integer");
  return Math.min(8, value);
}

function mapAuthorContext(author) {
  if (!author || typeof author !== "object")
    throw new TypeError("AuthorObservation is required for mapping");
  return {
    platformId: author.platformId,
    authorDirectoryName: author.authorDirectoryName,
    authorRelativePath: author.authorRelativePath,
    authorRelativePathKey: author.authorRelativePathKey,
  };
}

function createPreparationPool(options = {}) {
  const maxWorkers = normalizeWorkerCount(options.maxWorkers);
  const workerPath = options.workerPath || DEFAULT_WORKER_PATH;
  let nextId = 1;
  let closed = false;
  let closePromise = null;
  let workers = [];
  let idle = [];
  let nextWorkerId = 1;
  let workMs = 0;
  let peakReportedWorkerHeapBytes = 0;
  const workerHeapBytes = new Map();
  const pending = new Map();

  function closedError() {
    return errorWithCode(
      "PREPARATION_POOL_CLOSED",
      "Preparation pool is closed",
    );
  }

  function cancelError() {
    return errorWithCode("PREPARATION_CANCELLED", "Preparation cancelled");
  }

  function failClosed(error) {
    if (closed) return closePromise || Promise.resolve();
    closed = true;
    const failure = error instanceof Error
      ? error
      : errorWithCode("PREPARATION_WORKER_FAILED", String(error));
    for (const job of pending.values()) {
      try { job.reject(failure); } catch {}
      if (job.removeAbort) job.removeAbort();
    }
    pending.clear();
    const current = workers;
    workers = [];
    idle = [];
    closePromise = Promise.all(
      current.map((worker) => Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => undefined)),
    ).then(() => undefined);
    return closePromise;
  }

  function onWorkerExit(worker, code) {
    if (closed) return;
    const jobId = worker.jobId;
    const error = errorWithCode(
      "PREPARATION_WORKER_FAILED",
      `Preparation worker exited before terminal message (${code})`,
    );
    void failClosed(error);
  }

  function createWorker() {
    if (closed) throw closedError();
    const worker = new Worker(workerPath);
    worker.workerId = `worker-${nextWorkerId++}`;
    worker.jobId = null;
    worker.on("message", (message) => {
      if (!message || typeof message.id !== "number") return;
      const job = pending.get(message.id);
      if (!job) return;
      if (message.type === "error") {
        void failClosed(errorWithCode(
          message.error?.code || "PREPARATION_WORKER_FAILED",
          "Preparation worker failed",
        ));
        return;
      }
      if (message.type !== "result") {
        void failClosed(errorWithCode(
          "PREPARATION_PROTOCOL_INVALID",
          "Preparation worker returned an invalid message",
        ));
        return;
      }
      pending.delete(message.id);
      worker.jobId = null;
      if (job.removeAbort) job.removeAbort();
      const operationMs = Number(message.telemetry?.operationMs);
      const heapUsed = Number(message.telemetry?.heapUsed);
      if (Number.isFinite(operationMs) && operationMs >= 0)
        workMs += operationMs;
      if (Number.isSafeInteger(heapUsed) && heapUsed >= 0) {
        workerHeapBytes.set(worker.workerId, heapUsed);
        peakReportedWorkerHeapBytes = Math.max(
          peakReportedWorkerHeapBytes,
          heapUsed,
        );
      }
      if (!closed) idle.push(worker);
      job.resolve(message.value);
    });
    worker.on("error", () => {
      void failClosed(errorWithCode(
        "PREPARATION_WORKER_FAILED",
        "Preparation worker failed",
      ));
    });
    worker.on("exit", (code) => onWorkerExit(worker, code));
    workers.push(worker);
    return worker;
  }

  function takeWorker() {
    if (idle.length) return idle.pop();
    if (workers.length < maxWorkers) return createWorker();
    return null;
  }

  function submit(operation, payload, submitOptions = {}) {
    if (closed) return Promise.reject(closedError());
    const signal = submitOptions.signal;
    if (signal?.aborted) return Promise.reject(cancelError());
    const worker = takeWorker();
    if (!worker)
      return Promise.reject(errorWithCode(
        "PREPARATION_POOL_BUSY",
        "Preparation pool has no available worker; caller must apply backpressure",
      ));
    const id = nextId++;
    worker.jobId = id;
    return new Promise((resolve, reject) => {
      const removeAbort = signal
        ? () => signal.removeEventListener("abort", onAbort)
        : null;
      const onAbort = () => { void failClosed(cancelError()); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { resolve, reject, removeAbort });
      try {
        worker.postMessage({ id, operation, ...payload });
      } catch (error) {
        void failClosed(errorWithCode(
          "PREPARATION_WORKER_FAILED",
          "Unable to submit preparation work",
        ));
      }
    });
  }

  function prepare(work, submitOptions) {
    return submit("prepare", { work }, submitOptions);
  }

  function prepareMapped(work, author, selections, submitOptions) {
    return submit(
      "prepareMapped",
      { work, author: mapAuthorContext(author), selections },
      submitOptions,
    );
  }

  function map(entry, author, selections, submitOptions) {
    return submit(
      "map",
      { entry, author: mapAuthorContext(author), selections },
      submitOptions,
    );
  }

  function cancel(reason) {
    return failClosed(cancelError());
  }

  function close() {
    return failClosed(closedError());
  }

  function stats() {
    return Object.freeze({
      maxWorkers,
      workers: workers.length,
      idleWorkers: idle.length,
      inFlight: pending.size,
      workMs,
      workerHeapUsedBytes: Object.fromEntries(workerHeapBytes),
      peakReportedWorkerHeapBytes,
      closed,
    });
  }

  return Object.freeze({
    maxWorkers,
    prepare,
    prepareMapped,
    map,
    cancel,
    close,
    stats,
  });
}

module.exports = {
  DEFAULT_WORKER_PATH,
  createPreparationPool,
  defaultWorkerCount,
  normalizeWorkerCount,
};
