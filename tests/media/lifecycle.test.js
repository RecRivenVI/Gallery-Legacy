"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Database = require("../support/sqlite.js").Database;

const {
  applyMappedBatch,
  initializeCatalog,
} = require("../../internal/catalog/writer.js");
const {
  evaluateFilesystemMediaEligibility,
} = require("../../internal/media/index.js");
const {
  mapReconciledMediaToRelational,
  reconcileMedia,
} = require("../../internal/media/reconciliation/index.js");
const {
  observePlatformTree,
  observePlatformWorksStreaming,
} = require("../../internal/library/observation.js");
const {
  preparePlatformSnapshot,
} = require("../../internal/indexing/preparation.js");
const { createTempRoot, createWork } = require("../support/filesystem.js");

function file(relativePath, type) {
  const name = relativePath.split(/[\\/]/).at(-1);
  return {
    relativePath,
    relativePathKey: relativePath.toLowerCase(),
    directoryRelativePath: null,
    fileName: name,
    extension: name.slice(name.lastIndexOf(".")),
    size: 10,
    mtimeNs: 10n,
    entryType: "regular_file",
    expectedType: type,
  };
}

test("ambiguous and type-conflicting metadata never erase actual filesystem media", () => {
  const filesystemFiles = [
    file("a\\same.jpg", "image"),
    file("b\\same.jpg", "image"),
    file("clip.webm", "video"),
  ];
  const metadataDeclarations = [
    {
      sourceId: "ambiguous",
      kind: "image",
      name: "same.jpg",
      fileReferences: [
        { kind: "file_name", value: "same.jpg", sourcePath: "$.name" },
      ],
    },
    {
      sourceId: "conflict",
      kind: "image",
      name: "clip.webm",
      fileReferences: [
        { kind: "file_name", value: "clip.webm", sourcePath: "$.name" },
      ],
    },
  ];
  const reconciliation = reconcileMedia({
    metadataDeclarations,
    filesystemFiles,
  });
  const eligibility = evaluateFilesystemMediaEligibility({ filesystemFiles });
  const result = mapReconciledMediaToRelational({
    metadataDeclarations,
    filesystemFiles,
    reconciliation,
    eligibility,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mediaCounts, {
    imageCount: 2,
    videoCount: 1,
    mediaCount: 3,
  });
  assert.deepEqual(
    result.declarationRows.map((row) => row.match_state),
    ["ambiguous", "type_conflict"],
  );
  assert.equal(
    result.actualMediaRows.find((row) => row.relative_path === "clip.webm")
      .filesystem_media_type,
    "video",
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "ambiguous_media_enrichment",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "metadata_media_type_conflict",
    ),
  );
});

test("complete filesystem snapshot replaces actual media; incomplete snapshot cannot destructively erase it", (t) => {
  const root = createTempRoot(t, "gallery-fa-media-");
  const workRoot = createWork(root, "100", "2026-01-01_00-00-00_1", {
    metadata: JSON.stringify({ id: "1", user: { id: "100" } }),
    files: { "cover.jpg": "image" },
  });
  const first = preparePlatformSnapshot(
    observePlatformTree({ platformId: "pixiv", observationRoot: root }),
  );
  const db = new Database(":memory:");
  try {
    initializeCatalog(db, {
      builtAtMs: 1,
      platformRoots: require("../support/sources.js").sources(),
    });
    applyMappedBatch(db, first.preparedCandidates, { observedAtMs: 1 });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media").get().count,
      1n,
    );
    const incompleteObservation = structuredClone(
      observePlatformTree({ platformId: "pixiv", observationRoot: root }),
    );
    const incompleteWork = incompleteObservation.authors[0].works[0];
    incompleteWork.filesystemFilesState = "incomplete";
    incompleteWork.filesystemFiles = [];
    const incomplete = preparePlatformSnapshot(incompleteObservation);
    applyMappedBatch(db, incomplete.preparedCandidates, { observedAtMs: 2 });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media").get().count,
      1n,
    );
    require("node:fs").rmSync(require("node:path").join(workRoot, "cover.jpg"));
    const completeMissing = preparePlatformSnapshot(
      observePlatformTree({ platformId: "pixiv", observationRoot: root }),
    );
    applyMappedBatch(db, completeMissing.preparedCandidates, {
      observedAtMs: 3,
    });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media").get().count,
      0n,
    );
    assert.deepEqual(
      db.prepare("SELECT media_count,image_count,video_count FROM works").get(),
      { media_count: 0n, image_count: 0n, video_count: 0n },
    );
  } finally {
    db.close();
  }
});

test("streaming observer yields one bounded author scope and matches full physical snapshot", (t) => {
  const root = createTempRoot(t, "gallery-fa-stream-");
  for (let author = 1; author <= 3; author++)
    for (let work = 1; work <= 2; work++)
      createWork(root, String(author), `2026-01-0${work}_00-00-00_${work}`, {
        files: { [`${work}.jpg`]: "x" },
      });
  const full = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  const yielded = [];
  const authors = [];
  const summary = observePlatformWorksStreaming({
    platformId: "pixiv",
    observationRoot: root,
    onAuthorStart(author) {
      authors.push(author.authorRelativePathKey);
    },
    onWork(work) {
      yielded.push(work);
    },
    onAuthorEnd() {},
  });
  assert.equal(Object.hasOwn(summary, "authors"), false);
  assert.equal(summary.authorsObserved, 3);
  assert.equal(summary.worksObserved, 6);
  assert.equal(summary.filesystemFilesObserved, 6);
  assert.deepEqual(
    authors,
    full.authors.map((author) => author.authorRelativePathKey),
  );
  assert.deepEqual(
    yielded.map((work) => work.workRelativePathKey),
    full.authors.flatMap((author) =>
      author.works.map((work) => work.workRelativePathKey),
    ),
  );
  assert.ok(yielded.every(Object.isFrozen));
});
