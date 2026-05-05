"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  CATALOG_SCHEMA_VERSION,
  INDEX_NAMES,
  SCHEMA_SQL,
  TABLE_NAMES,
} = require("../../internal/catalog/schema.js");
const { stableJson } = require("../../internal/catalog/stable-json.js");
const { PLATFORM_REGISTRY } = require("../../internal/library/platforms.js");
const {
  insertAuthor,
  insertCatalogState,
  insertPlatforms,
  insertShape,
  insertWork,
  openCatalog,
  schemaSnapshot,
} = require("../support/catalog.js");

const PREVIOUS_SCHEMA_V3_SNAPSHOT_SHA256 =
  "f2893607bc77931de8de964a3f1f49b4996e7a01c7e350e2e1cdf8097b640e8b";
const EXPECTED_SCHEMA_V4_SNAPSHOT_SHA256 =
  "0e83c8c72b79ed7b870c1b3f7babf7edd15a72862fac0dd7d9021e78eeb4171b";

test("fresh DB creates deterministic Filesystem Authority Schema v4", () => {
  const db = openCatalog();
  try {
    assert.equal(CATALOG_SCHEMA_VERSION, 4);
    assert.equal(TABLE_NAMES.length, 18);
    assert.ok(TABLE_NAMES.includes("media_declarations"));
    assert.doesNotMatch(
      SCHEMA_SQL,
      /filesystem_source_present|metadata_source_present|fts5|CREATE\s+VIRTUAL\s+TABLE/i,
    );
    const hash = crypto
      .createHash("sha256")
      .update(stableJson(schemaSnapshot(db)), "utf8")
      .digest("hex");
    assert.equal(hash, EXPECTED_SCHEMA_V4_SNAPSHOT_SHA256);
    assert.notEqual(hash, PREVIOUS_SCHEMA_V3_SNAPSHOT_SHA256);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      TABLE_NAMES,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      INDEX_NAMES,
    );
  } finally {
    db.close();
  }
});

test("catalog state and platform rows freeze registry and filesystem authority contract", () => {
  const db = openCatalog();
  try {
    const state = insertCatalogState(db);
    const stored = db.prepare("SELECT * FROM catalog_state").get();
    assert.equal(stored.schema_version, 4n);
    assert.equal(
      stored.adapter_contract_version,
      BigInt(state.adapter_contract_version),
    );
    assert.equal(stored.filesystem_authority_contract_version, 1n);
    const platforms = insertPlatforms(db);
    assert.equal(platforms.length, 8);
    assert.deepEqual(
      platforms.map((row) => row.platform_id),
      PLATFORM_REGISTRY.map((row) => row.id),
    );
  } finally {
    db.close();
  }
});

test("physical path is natural identity while source IDs are nullable and non-unique", () => {
  const db = openCatalog();
  try {
    insertPlatforms(db);
    const authorA = insertAuthor(db, "pixiv", "100", "-a");
    const authorB = insertAuthor(db, "pixiv", "100", "-b");
    const first = insertWork(db, {
      platformId: "pixiv",
      sourceWorkId: "9",
      authorId: authorA,
      relativePath: "100-a\\2026-01-01_00-00-00_9",
    });
    const second = insertWork(db, {
      platformId: "pixiv",
      sourceWorkId: "9",
      authorId: authorB,
      relativePath: "100-b\\2026-01-02_00-00-00_9",
    });
    assert.equal(
      db
        .prepare("SELECT count(*) AS count FROM works WHERE source_work_id='9'")
        .get().count,
      2n,
    );
    db.prepare(
      "UPDATE works SET source_work_id=NULL,source_work_id_source=NULL WHERE work_id=?",
    ).run(second);
    assert.equal(
      db.prepare("SELECT source_work_id FROM works WHERE work_id=?").get(second)
        .source_work_id,
      null,
    );
    assert.throws(
      () =>
        insertWork(db, {
          platformId: "pixiv",
          sourceWorkId: "other",
          authorId: authorA,
          relativePath: "100-A\\2026-01-01_00-00-00_9",
        }),
      /UNIQUE constraint failed/,
    );
    assert.ok(first > 0n);
  } finally {
    db.close();
  }
});

test("actual media requires filesystem facts; declarations are separate and never affect counts", () => {
  const db = openCatalog();
  try {
    insertPlatforms(db);
    const authorId = insertAuthor(db, "pixiv", "100");
    const workId = insertWork(db, {
      platformId: "pixiv",
      sourceWorkId: "9",
      authorId,
      relativePath: "100\\2026-01-01_00-00-00_9",
    });
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO media(work_id,relative_path) VALUES (?,'ghost.jpg')",
          )
          .run(workId),
      /NOT NULL constraint failed/,
    );
    const mediaId = db
      .prepare(
        `INSERT INTO media(work_id,relative_path,relative_path_key,filesystem_file_name,filesystem_extension,filesystem_size,filesystem_mtime_ns,filesystem_media_type)
      VALUES (?,'1.webm','1.webm','1.webm','.webm',100,9007199254740993,'video')`,
      )
      .run(workId).lastInsertRowid;
    db.prepare(
      `INSERT INTO media_declarations(work_id,ordinal,source_media_id,declared_name,declared_media_type,match_state,matched_media_id)
      VALUES (?,0,'frame-0','000000.jpg','animation_frame','unmatched',NULL)`,
    ).run(workId);
    db.prepare(
      "UPDATE works SET media_count=1,video_count=1 WHERE work_id=?",
    ).run(workId);
    assert.deepEqual(
      db
        .prepare(
          "SELECT media_count,image_count,video_count FROM works WHERE work_id=?",
        )
        .get(workId),
      { media_count: 1n, image_count: 0n, video_count: 1n },
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media").get().count,
      1n,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM media_declarations").get()
        .count,
      1n,
    );
    db.prepare("UPDATE works SET cover_media_id=? WHERE work_id=?").run(
      mediaId,
      workId,
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("metadata shape is optional and nanosecond filesystem facts remain BigInt", () => {
  const db = openCatalog();
  try {
    insertPlatforms(db);
    const authorId = insertAuthor(db, "pixiv", "100");
    const workId = insertWork(db, {
      platformId: "pixiv",
      sourceWorkId: "9",
      authorId,
      relativePath: "100\\work",
      shapeId: null,
    });
    const exact = 1700000000123456789n;
    db.prepare(
      "UPDATE works SET work_dir_mtime_ns=?,metadata_state='missing',enrichment_state='unavailable',metadata_shape_id=NULL WHERE work_id=?",
    ).run(exact, workId);
    const row = db
      .prepare(
        "SELECT work_dir_mtime_ns,metadata_shape_id,metadata_state FROM works WHERE work_id=?",
      )
      .get(workId);
    assert.equal(row.work_dir_mtime_ns, exact);
    assert.equal(row.metadata_shape_id, null);
    assert.equal(row.metadata_state, "missing");
    const shape = insertShape(db, "pixiv", "a".repeat(64));
    db.prepare("UPDATE works SET metadata_shape_id=? WHERE work_id=?").run(
      shape,
      workId,
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
