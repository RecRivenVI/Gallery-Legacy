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
  const value = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("runtime_count_out_of_range", `${table} count is outside the safe reporting range`);
  return Number(value);
}

function countGroups(db, sql) {
  const row = db.prepare(sql).get();
  return { groups: Number(row.groups_count), entities: Number(row.entities) };
}

function validateActiveCatalog(db) {
  verifyCatalogContract(db);
  const foreignKeys = db.pragma("foreign_key_check");
  if (foreignKeys.length) fail("runtime_foreign_key_check_failed", "Catalog foreign_key_check failed", foreignKeys);
  const integrity = db.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("runtime_integrity_check_failed", "Catalog integrity_check failed", integrity);

  assertNoRows(db, `SELECT author_id FROM authors WHERE
    work_count<>(SELECT count(*) FROM works WHERE works.author_id=authors.author_id) LIMIT 1`, "runtime_author_count_mismatch", "Author work_count mismatch");
  assertNoRows(db, `SELECT tag_id FROM tags WHERE
    work_count<>(SELECT count(*) FROM work_tags WHERE work_tags.tag_id=tags.tag_id) LIMIT 1`, "runtime_tag_count_mismatch", "Tag work_count mismatch");
  assertNoRows(db, `SELECT metadata_shape_id FROM metadata_shapes WHERE
    work_count<>(SELECT count(*) FROM works WHERE works.metadata_shape_id=metadata_shapes.metadata_shape_id) LIMIT 1`, "runtime_shape_count_mismatch", "Shape work_count mismatch");
  assertNoRows(db, `SELECT work_id FROM works WHERE
    media_count<>(SELECT count(*) FROM media WHERE media.work_id=works.work_id) OR
    image_count<>(SELECT count(*) FROM media WHERE media.work_id=works.work_id AND filesystem_media_type='image') OR
    video_count<>(SELECT count(*) FROM media WHERE media.work_id=works.work_id AND filesystem_media_type='video') LIMIT 1`, "runtime_media_count_mismatch", "Work actual media counts differ from filesystem-backed rows");
  assertNoRows(db, `SELECT media_id FROM media WHERE relative_path IS NULL OR relative_path_key IS NULL OR filesystem_file_name IS NULL
    OR filesystem_size IS NULL OR filesystem_mtime_ns IS NULL OR filesystem_media_type NOT IN ('image','video') LIMIT 1`, "runtime_nonphysical_media", "Actual media table contains a non-filesystem row");
  assertNoRows(db, `SELECT media_declaration_id FROM media_declarations d LEFT JOIN media m ON m.media_id=d.matched_media_id
    WHERE (d.match_state='matched' AND (m.media_id IS NULL OR m.work_id<>d.work_id))
       OR (d.match_state<>'matched' AND d.matched_media_id IS NOT NULL) LIMIT 1`, "runtime_declaration_match_invalid", "Metadata declaration match escapes its physical work");
  assertNoRows(db, `SELECT author_id FROM authors WHERE profile_state<>'valid' AND (
    latest_work_id IS NOT NULL OR latest_work_at_ms IS NOT NULL OR
    EXISTS(SELECT 1 FROM author_profiles p WHERE p.author_id=authors.author_id) OR
    EXISTS(SELECT 1 FROM author_aliases a WHERE a.author_id=authors.author_id)
  ) LIMIT 1`, "runtime_invalid_profile_stale_facts", "Unavailable profile retains old metadata authority");
  assertNoRows(db, `SELECT a.author_id FROM authors a JOIN author_profiles p USING(author_id)
    LEFT JOIN works w ON w.work_id=a.latest_work_id
    WHERE a.profile_state<>'valid' OR w.work_id IS NULL OR w.author_id<>a.author_id OR p.authority_work_id<>w.work_id LIMIT 1`, "runtime_authority_mismatch", "Current profile/latest physical work mismatch");
  assertNoRows(db, `SELECT author_id FROM authors WHERE display_name IS NULL OR length(display_name)=0
    OR relative_path IS NULL OR relative_path_key IS NULL LIMIT 1`, "runtime_author_physical_identity_invalid", "Author fallback or physical identity is invalid");
  assertNoRows(db, `SELECT work_id FROM works WHERE title IS NULL OR length(title)=0 OR relative_path IS NULL OR relative_path_key IS NULL
    OR work_dir_mtime_ns IS NULL LIMIT 1`, "runtime_work_physical_identity_invalid", "Work fallback or physical identity is invalid");
  assertNoRows(db, `SELECT work_id FROM works WHERE (source_work_id IS NULL)<>(source_work_id_source IS NULL) LIMIT 1`, "runtime_work_source_provenance_invalid", "Work source identity/provenance mismatch");
  assertNoRows(db, `SELECT author_id FROM authors WHERE (source_author_id IS NULL)<>(source_author_id_source IS NULL) LIMIT 1`, "runtime_author_source_provenance_invalid", "Author source identity/provenance mismatch");
  assertNoRows(db, `SELECT work_id FROM works WHERE relative_path LIKE '%/../%' OR relative_path LIKE '../%' OR relative_path LIKE '%\\..\\%' LIMIT 1`, "runtime_path_escape", "Catalog contains a path escape");

  const metadataStates = Object.fromEntries(db.prepare("SELECT metadata_state,count(*) AS count FROM works GROUP BY metadata_state ORDER BY metadata_state").all().map(row => [row.metadata_state, Number(row.count)]));
  const sourceWorkCollisions = countGroups(db, `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM works WHERE source_work_id IS NOT NULL GROUP BY platform_id,source_work_id HAVING count(*)>1)`);
  const sourceAuthorCollisions = countGroups(db, `SELECT count(*) AS groups_count,coalesce(sum(entity_count),0) AS entities FROM (
    SELECT count(*) AS entity_count FROM authors WHERE source_author_id IS NOT NULL GROUP BY platform_id,source_author_id HAVING count(*)>1)`);
  return {
    platforms: safeCount(db, "platforms"),
    authors: safeCount(db, "authors"),
    works: safeCount(db, "works"),
    media: safeCount(db, "media"),
    mediaDeclarations: safeCount(db, "media_declarations"),
    tags: safeCount(db, "tags"),
    relations: safeCount(db, "social_relations"),
    shapes: safeCount(db, "metadata_shapes"),
    unavailableProfiles: Number(db.prepare("SELECT count(*) AS count FROM authors WHERE profile_state<>'valid'").get().count),
    metadataStates,
    sourceWorkCollisions,
    sourceAuthorCollisions,
  };
}

module.exports = { CatalogValidationError, validateCatalog: validateActiveCatalog, validateActiveCatalog };
