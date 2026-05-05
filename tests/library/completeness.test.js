"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { NODE_FS_IO } = require("../../internal/library/observer.js");
const {
  observePlatformTree,
  observePlatformTreeStreaming,
  observePlatformWorksStreaming,
} = require("../../internal/library/observation.js");
const {
  initializeCatalog,
  applyMappedBatch,
} = require("../../internal/catalog/writer.js");
const {
  preparePlatformSnapshot,
  createStreamingAuthorPreparation,
} = require("../../internal/indexing/preparation.js");
const { createTempRoot, createWork } = require("../support/filesystem.js");
const { Database } = require("../support/sqlite.js");

function fixture(t) {
  const root = createTempRoot(t, "gallery-completeness-");
  const work = createWork(root, "100", "2020-01-01_00-00-00_200", {
    metadata: "{}",
    files: {
      "visible.jpg": "synthetic-image",
      "nested/hidden.webm": "synthetic-video",
    },
  });
  return {
    root,
    work,
    author: path.dirname(work),
    nested: path.join(work, "nested"),
  };
}

function failingIo(operation, target, code) {
  return {
    ...NODE_FS_IO,
    [operation](candidate) {
      if (candidate === target)
        throw Object.assign(new Error("Synthetic filesystem failure"), {
          code,
        });
      return NODE_FS_IO[operation](candidate);
    },
  };
}

test("nested enumeration failure reaches work, author and platform without dropping the physical work", (t) => {
  const f = fixture(t);
  const io = failingIo("readdir", f.nested, "EACCES");
  const snapshot = observePlatformTree({
    platformId: "pixiv",
    observationRoot: f.root,
    io,
  });
  assert.equal(snapshot.authorsState, "incomplete");
  assert.equal(snapshot.authors.length, 1);
  const author = snapshot.authors[0];
  assert.equal(author.worksState, "incomplete");
  assert.equal(author.childWorkCountObserved, 1);
  assert.equal(author.works[0].state, "present");
  assert.equal(author.works[0].filesystemFilesState, "incomplete");
  assert.equal(author.works[0].filesystemFiles.length, 1);
  assert.ok(author.works[0].diagnostics.some((d) => d.osCode === "EACCES"));
  assert.ok(
    author.diagnostics.some((d) => d.code === "work_observation_incomplete"),
  );
  assert.deepEqual(
    observePlatformTree({ platformId: "pixiv", observationRoot: f.root, io }),
    snapshot,
  );

  // Existing orchestration consumes the corrected facts; publication is not
  // changed or invoked here. Catalog stores incompleteness and keeps the work.
  const prepared = preparePlatformSnapshot(snapshot);
  assert.equal(prepared.authorOutcomes[0].preparationState, "incomplete");
  const db = new Database(":memory:");
  try {
    initializeCatalog(db, {
      builtAtMs: 1,
      platformRoots: require("../support/sources.js").sources(),
    });
    applyMappedBatch(db, prepared.preparedCandidates, { observedAtMs: 1 });
    assert.deepEqual(
      db.prepare("SELECT filesystem_files_state,media_count FROM works").get(),
      { filesystem_files_state: "incomplete", media_count: 1n },
    );
  } finally {
    db.close();
  }
});

test("both streaming observers propagate descendant failure and retain bounded work delivery", (t) => {
  const f = fixture(t);
  const io = failingIo("readdir", f.nested, "EACCES");
  let author;
  const authors = observePlatformTreeStreaming({
    platformId: "pixiv",
    observationRoot: f.root,
    io,
    onAuthor(value) {
      author = value;
    },
  });
  assert.equal(authors.authorsState, "incomplete");
  assert.equal(author.worksState, "incomplete");
  let preparation;
  let completion;
  let observedWork;
  const works = observePlatformWorksStreaming({
    platformId: "pixiv",
    observationRoot: f.root,
    io,
    onAuthorStart(value) {
      preparation = createStreamingAuthorPreparation(value);
    },
    onWork(value) {
      observedWork = value;
      preparation.prepareWork(value);
    },
    onAuthorEnd(value) {
      completion = preparation.finish(value);
    },
  });
  assert.equal(works.authorsState, "incomplete");
  assert.equal(works.worksObserved, 1);
  assert.equal(works.filesystemFilesObserved, 1);
  assert.equal(Object.hasOwn(works, "authors"), false);
  assert.equal(observedWork.filesystemFilesState, "incomplete");
  assert.equal(completion.authorOutcome.preparationState, "incomplete");
});

test("file stat races and unreadable work directories cannot look like complete observations", (t) => {
  const f = fixture(t);
  for (const io of [
    failingIo("lstat", path.join(f.nested, "hidden.webm"), "ENOENT"),
    failingIo("readdir", f.work, "EACCES"),
  ]) {
    let completion;
    let work;
    const result = observePlatformWorksStreaming({
      platformId: "pixiv",
      observationRoot: f.root,
      io,
      onAuthorStart() {},
      onWork(value) {
        work = value;
      },
      onAuthorEnd(value) {
        completion = value;
      },
    });
    assert.equal(result.authorsState, "incomplete");
    assert.equal(result.worksObserved, 1);
    assert.equal(work.filesystemFilesState, "incomplete");
    assert.equal(completion.worksState, "incomplete");
  }
});

test("unreadable author enumeration reports unknown children and incomplete platform", (t) => {
  const f = fixture(t);
  let completion;
  const result = observePlatformWorksStreaming({
    platformId: "pixiv",
    observationRoot: f.root,
    io: failingIo("readdir", f.author, "EACCES"),
    onAuthorStart() {},
    onWork() {
      assert.fail("Unreadable author must not fabricate children");
    },
    onAuthorEnd(value) {
      completion = value;
    },
  });
  assert.equal(result.authorsState, "incomplete");
  assert.equal(completion.childWorkCountObserved, null);
  assert.equal(completion.state, "unreadable");
});

test("unreadable metadata alone does not make complete physical media incomplete", (t) => {
  const f = fixture(t);
  const snapshot = observePlatformTree({
    platformId: "pixiv",
    observationRoot: f.root,
    io: failingIo("readFile", path.join(f.work, "metadata.json"), "EACCES"),
  });
  assert.equal(snapshot.authorsState, "complete");
  const work = snapshot.authors[0].works[0];
  assert.equal(work.metadata.state, "unreadable");
  assert.equal(work.filesystemFilesState, "complete");
  const prepared = preparePlatformSnapshot(snapshot);
  assert.equal(prepared.preparedCandidates.length, 1);
  assert.deepEqual(
    prepared.preparedCandidates[0].mediaPersistence.mediaCounts,
    { imageCount: 1, videoCount: 1, mediaCount: 2 },
  );
});
