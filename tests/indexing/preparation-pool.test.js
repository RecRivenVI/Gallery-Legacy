"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const {
  createPreparationPool,
  defaultWorkerCount,
} = require("../../internal/indexing/preparation-pool.js");
const workerSource = fs.readFileSync(
  require.resolve("../../internal/indexing/preparation-worker.js"),
  "utf8",
);
const workerPath = require.resolve("../../internal/indexing/preparation-worker.js");
const {
  createStreamingAuthorPreparation,
} = require("../../internal/indexing/preparation.js");
const { observePlatformTree } = require("../../internal/library/observation.js");

function syntheticAuthor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-preparation-pool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "100", "2026-01-01_00-00-00_1");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, "metadata.json"),
    JSON.stringify({
      id: "1",
      date: "2026-01-01T00:00:00Z",
      title: "Synthetic title",
      user: { id: "100", name: "Synthetic author" },
    }),
  );
  fs.writeFileSync(path.join(work, "1.png"), Buffer.from([1, 2, 3]));
  return observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  }).authors[0];
}

test("preparation pool defaults to CPU count capped at eight and prepares/maps pure facts", async (t) => {
  assert.match(workerSource, /PREPARATION_IO_FORBIDDEN/);
  const author = syntheticAuthor(t);
  const pool = createPreparationPool({ maxWorkers: 1 });
  t.after(() => pool.close());
  assert.equal(pool.maxWorkers, 1);
  assert.equal(defaultWorkerCount() <= 8, true);

  const synchronous = createStreamingAuthorPreparation(author);
  const syncPrepared = synchronous.prepareWork(author.works[0]);
  const syncCompleted = synchronous.finish({ worksState: "complete" });
  const stream = createStreamingAuthorPreparation(author, { pool });
  const mapped = await pool.prepareMapped(
    author.works[0],
    author,
    stream.provisionalSelections(),
  );
  const prepared = stream.acceptPreparedEntry(mapped, { mapped: true });
  const completed = await stream.finishAsync({ worksState: "complete" });
  assert.equal(prepared.metadataDiagnostic.state, "valid");
  assert.deepEqual(prepared.metadataDiagnostic, syncPrepared.metadataDiagnostic);
  assert.equal(completed.authorOutcome.preparationState, "complete");
  assert.ok(completed.authoritativeCandidate);
  assert.deepEqual(
    completed.authoritativeCandidate.rows.work,
    syncCompleted.authoritativeCandidate.rows.work,
  );
  assert.equal(completed.authoritativeCandidate.rows.work.relative_path, "100\\2026-01-01_00-00-00_1");
  assert.equal(completed.authoritativeCandidate.mediaPersistence.actualMediaRows.length, 1);
  const telemetry = pool.stats();
  assert.equal(telemetry.inFlight, 0);
  assert.ok(telemetry.workMs >= 0);
  assert.ok(Object.keys(telemetry.workerHeapUsedBytes).length >= 1);
  assert.ok(Object.values(telemetry.workerHeapUsedBytes).every((value) => Number.isSafeInteger(value) && value > 0));
  assert.ok(telemetry.peakReportedWorkerHeapBytes >= Math.max(...Object.values(telemetry.workerHeapUsedBytes)));
  assert.equal(Object.hasOwn(telemetry, "workerRssBytes"), false);

  const convenience = createStreamingAuthorPreparation(author, { pool });
  const conveniencePrepared = await convenience.prepareWorkAsync(author.works[0]);
  await convenience.finishAsync({ worksState: "complete" });
  assert.equal(conveniencePrepared.metadataDiagnostic.state, "valid");
});

test("pool applies backpressure instead of creating an unbounded queue", async (t) => {
  const author = syntheticAuthor(t);
  const pool = createPreparationPool({ maxWorkers: 1 });
  t.after(() => pool.close());
  const first = pool.prepare(author.works[0]);
  await assert.rejects(pool.prepare(author.works[0]), { code: "PREPARATION_POOL_BUSY" });
  await first;
  assert.equal(pool.stats().inFlight, 0);
});

test("worker failure and cancellation fail closed and terminate the pool", async (t) => {
  const author = syntheticAuthor(t);
  const failed = createPreparationPool({ maxWorkers: 1 });
  t.after(() => failed.close());
  await assert.rejects(failed.map(null, author, {}), (error) => {
    assert.equal(error.code, "PREPARATION_WORKER_FAILED");
    return true;
  });
  assert.equal(failed.stats().closed, true);
  await assert.rejects(failed.prepare(author.works[0]), { code: "PREPARATION_POOL_CLOSED" });

  const cancelled = createPreparationPool({ maxWorkers: 1 });
  t.after(() => cancelled.close());
  const controller = new AbortController();
  const pending = cancelled.prepare(author.works[0], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "PREPARATION_CANCELLED" });
  assert.equal(cancelled.stats().closed, true);
  await assert.rejects(cancelled.prepare(author.works[0]), { code: "PREPARATION_POOL_CLOSED" });
});

test("worker rejects filesystem access at runtime and close waits for termination", async (t) => {
  const worker = new Worker(workerPath);
  const result = await new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", resolve);
    worker.postMessage({ id: 1, operation: "__test_io" });
  });
  assert.deepEqual(result, {
    type: "error",
    id: 1,
    error: {
      code: "PREPARATION_IO_FORBIDDEN",
      message: "Preparation worker I/O is forbidden",
    },
  });
  await worker.terminate();

  const pool = createPreparationPool({ maxWorkers: 1 });
  const author = syntheticAuthor(t);
  await pool.prepare(author.works[0]);
  const closing = pool.close();
  assert.equal(closing instanceof Promise, true);
  await closing;
  assert.equal(pool.stats().workers, 0);
  assert.equal(pool.stats().closed, true);
});
