"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Database = require("../support/sqlite.js").Database;

const {
  initializeCatalog,
  applyMappedBatch,
  verifyCatalogContract,
} = require("../../internal/catalog/writer.js");
const {
  observePlatformTree,
} = require("../../internal/library/observation.js");
const {
  preparePlatformSnapshot,
} = require("../../internal/indexing/preparation.js");
const { createTempRoot, createWork } = require("../support/filesystem.js");

function pixivMetadata(id, userId, extra = {}) {
  return JSON.stringify({
    id,
    user: { id: userId, name: `Author ${userId}` },
    title: `Title ${id}`,
    ...extra,
  });
}

function prepare(t, works) {
  const root = createTempRoot(t, "gallery-filesystem-authority-");
  for (const work of works)
    createWork(root, work.author, work.work, {
      ...(Object.hasOwn(work, "metadata") ? { metadata: work.metadata } : {}),
      files: work.files || {},
    });
  const observation = observePlatformTree({
    platformId: "pixiv",
    observationRoot: root,
  });
  return { observation, preparation: preparePlatformSnapshot(observation) };
}

test("filesystem work/media remain indexable when metadata is missing, malformed, or non-object", (t) => {
  const { preparation } = prepare(t, [
    {
      author: "100",
      work: "2026-01-01_00-00-00_1",
      files: { "1.jpg": "image" },
    },
    {
      author: "100",
      work: "2026-01-02_00-00-00_2",
      metadata: "{",
      files: { "2.webm": "video" },
    },
    {
      author: "100",
      work: "2026-01-03_00-00-00_3",
      metadata: "[]",
      files: { "3.png": "image" },
    },
  ]);
  assert.equal(preparation.preparedCandidates.length, 3);
  assert.equal(preparation.workFailures.length, 0);
  assert.deepEqual(
    preparation.preparedCandidates.map(
      (candidate) => candidate.rows.work.metadata_state,
    ),
    ["missing", "malformed", "non_object"],
  );
  assert.deepEqual(
    preparation.preparedCandidates.map(
      (candidate) => candidate.mediaPersistence.mediaCounts,
    ),
    [
      { imageCount: 1, videoCount: 0, mediaCount: 1 },
      { imageCount: 0, videoCount: 1, mediaCount: 1 },
      { imageCount: 1, videoCount: 0, mediaCount: 1 },
    ],
  );
  assert.deepEqual(
    preparation.preparedCandidates.map(
      (candidate) => candidate.rows.work.title,
    ),
    ["1", "2", "3"],
  );
  assert.ok(
    preparation.preparedCandidates.every(
      (candidate) => candidate.rows.work.title_source === "directory_parsed",
    ),
  );
});

test("metadata declarations cannot create actual media and filesystem type wins", (t) => {
  const { preparation } = prepare(t, [
    {
      author: "9000001",
      work: "2026-01-01_00-00-00_90000001",
      metadata: pixivMetadata("90000001", "9000001", {
        frames: [
          { file: "000000.jpg", delay: 65 },
          { file: "000001.jpg", delay: 65 },
        ],
      }),
      files: { "1.webm": "video", "1.zip": "archive" },
    },
  ]);
  const candidate = preparation.preparedCandidates[0];
  assert.deepEqual(candidate.mediaPersistence.mediaCounts, {
    imageCount: 0,
    videoCount: 1,
    mediaCount: 1,
  });
  assert.equal(
    candidate.mediaPersistence.actualMediaRows[0].filesystem_media_type,
    "video",
  );
  assert.equal(candidate.mediaPersistence.declarationRows.length, 2);
  assert.ok(
    candidate.mediaPersistence.declarationRows.every(
      (row) => row.match_state === "unmatched",
    ),
  );
  assert.deepEqual(
    candidate.mediaPersistence.actualMediaRows.map((row) => row.relative_path),
    ["1.webm"],
  );
});

test("duplicate source IDs retain both physical works and persist as collisions", (t) => {
  const { preparation } = prepare(t, [
    {
      author: "100",
      work: "2026-01-01_00-00-00_9",
      metadata: pixivMetadata("9", "100"),
      files: { "a.jpg": "a" },
    },
    {
      author: "100",
      work: "2026-01-02_00-00-00_9",
      metadata: pixivMetadata("9", "100"),
      files: { "b.jpg": "b" },
    },
  ]);
  assert.equal(preparation.preparedCandidates.length, 2);
  assert.equal(preparation.sourceIdentityCollisions.length, 1);
  assert.equal(preparation.sourceIdentityCollisions[0].entityKind, "work");

  const db = new Database(":memory:");
  try {
    initializeCatalog(db, {
      builtAtMs: 1700000000000,
      platformRoots: require("../support/sources.js").sources(),
    });
    applyMappedBatch(db, preparation.preparedCandidates, {
      observedAtMs: 1700000000000,
    });
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM works").get().count,
      2n,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM works WHERE source_work_id='9'")
        .get().count,
      2n,
    );
    assert.equal(
      db.prepare("SELECT sum(media_count) AS count FROM works").get().count,
      2n,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media").get().count,
      2n,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media_declarations").get()
        .count,
      0n,
    );
    assert.equal(verifyCatalogContract(db), true);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("unparsed directory names remain physical identities without fake source IDs", (t) => {
  const root = createTempRoot(t, "gallery-filesystem-authority-raw-");
  createWork(root, "artist name", "freeform work", {
    files: { "cover.png": "image" },
  });
  const prepared = preparePlatformSnapshot(
    observePlatformTree({ platformId: "pixiv", observationRoot: root }),
  );
  const candidate = prepared.preparedCandidates[0];
  assert.equal(candidate.rows.author.source_author_id, null);
  assert.equal(candidate.rows.work.source_work_id, null);
  assert.equal(candidate.rows.author.display_name, "artist name");
  assert.equal(candidate.rows.work.title, "freeform work");
});
