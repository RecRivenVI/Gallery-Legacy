"use strict";

const { verifyCatalogContract } = require("./writer.js");

class CatalogValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CatalogValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CatalogValidationError(code, message, details);
}

function assertNoRows(db, sql, code, message) {
  const row = db.prepare(sql).get();
  if (row) fail(code, message, row);
}

function safeCount(db, table) {
  const value = db
    .prepare(`SELECT count(*) AS count FROM ${table}`)
    .get().count;
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail(
      "runtime_count_out_of_range",
      `${table} count is outside the safe reporting range`,
    );
  return Number(value);
}

function countGroups(db, sql) {
  const row = db.prepare(sql).get();
  return { groups: Number(row.groups_count), entities: Number(row.entities) };
}

function validateActiveCatalog(db, { allowLive = false } = {}) {
  verifyCatalogContract(db, { allowLive });
  const foreignKeys = db.pragma("foreign_key_check");
  if (foreignKeys.length)
    fail(
      "runtime_foreign_key_check_failed",
      "Catalog foreign_key_check failed",
      foreignKeys,
    );
  const integrity = db.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
    fail(
      "runtime_integrity_check_failed",
      "Catalog integrity_check failed",
      integrity,
    );

  for (const check of require("../../api/catalog-checks.json"))
    assertNoRows(db, check.sql, check.code, check.message);

  const metadataStates = Object.fromEntries(
    db
      .prepare(
        "SELECT metadata_state,count(*) AS count FROM works GROUP BY metadata_state ORDER BY metadata_state",
      )
      .all()
      .map((row) => [row.metadata_state, Number(row.count)]),
  );
  const sourceWorkCollisions = countGroups(
    db,
    `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM works WHERE source_work_id IS NOT NULL GROUP BY platform_id,source_work_id HAVING count(*)>1)`,
  );
  const sourceAuthorCollisions = countGroups(
    db,
    `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM authors WHERE source_author_id IS NOT NULL GROUP BY platform_id,source_author_id HAVING count(*)>1)`,
  );
  return {
    platforms: safeCount(db, "platforms"),
    authors: safeCount(db, "authors"),
    works: safeCount(db, "works"),
    media: safeCount(db, "media"),
    mediaDeclarations: safeCount(db, "media_declarations"),
    tags: safeCount(db, "tags"),
    relations: safeCount(db, "social_relations"),
    shapes: safeCount(db, "metadata_shapes"),
    unavailableProfiles: Number(
      db
        .prepare(
          "SELECT count(*) AS count FROM authors WHERE profile_state<>'valid'",
        )
        .get().count,
    ),
    metadataStates,
    sourceWorkCollisions,
    sourceAuthorCollisions,
  };
}

module.exports = {
  CatalogValidationError,
  validateCatalog: validateActiveCatalog,
  validateActiveCatalog,
};
