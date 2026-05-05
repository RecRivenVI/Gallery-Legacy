"use strict";

const { CATALOG_SCHEMA_VERSION, createCatalogSchema } = require("./schema.js");
const { mapCatalogState, mapPlatformRegistry } = require("./mapping.js");
const { validateReconciledMediaPersistence } = require("./media-persistence.js");
const { createAffectedCounts, recountAffectedCounts } = require("./counts.js");
const { compareText } = require("../library/paths.js");
const { stableJson } = require("./stable-json.js");

class CatalogWriterError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CatalogWriterError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CatalogWriterError(code, message, details);
}

function naturalKey(...parts) {
  return parts.map(value => String(value)).join("\u0000");
}

function comparisonValue(value) {
  if (typeof value === "bigint") return { $catalogBigInt: value.toString() };
  if (Array.isArray(value)) return value.map(comparisonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparisonValue(item)]));
  return value;
}

function canonicalCandidate(candidate) {
  return stableJson(comparisonValue(candidate));
}

function assertSafeIntegerConnection(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") fail("invalid_database", "Catalog writer requires a better-sqlite3 connection");
  const probe = db.prepare("SELECT CAST('9007199254740993' AS INTEGER) AS value").get().value;
  if (probe !== 9007199254740993n) fail("unsafe_integer_mode", "Catalog writer requires db.defaultSafeIntegers(true)");
  if (db.pragma("foreign_keys", { simple: true }) !== 1n) fail("foreign_keys_disabled", "Catalog writer requires foreign_keys=ON");
}

function validateTransactionContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "observedAtMs")
    || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) fail("invalid_transaction_context", "Transaction context only accepts a non-negative safe observedAtMs");
  return { observedAtMs: value.observedAtMs };
}

function normalizeDbInteger(value) {
  if (typeof value !== "bigint" || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("catalog_contract_mismatch", "Catalog contract integer is outside the safe comparison range");
  return Number(value);
}

function verifyCatalogContract(db) {
  assertSafeIntegerConnection(db);
  const platformRoots = Object.fromEntries(db.prepare("SELECT platform_id,physical_root FROM platforms").all().map(row => [row.platform_id,row.physical_root]));
  const expected = mapCatalogState({ catalogRevision: 0, builtAtMs: 0, platformRoots });
  const state = db.prepare("SELECT * FROM catalog_state WHERE singleton=1").get();
  if (!state) fail("catalog_contract_mismatch", "Catalog state row is missing");
  const actualFacts = {
    schema_version: normalizeDbInteger(state.schema_version),
    adapter_contract_version: normalizeDbInteger(state.adapter_contract_version),
    shape_signature_version: normalizeDbInteger(state.shape_signature_version),
    filesystem_authority_contract_version: normalizeDbInteger(state.filesystem_authority_contract_version),
    normalizer_version: state.normalizer_version === null ? null : normalizeDbInteger(state.normalizer_version),
    sanitizer_version: state.sanitizer_version === null ? null : normalizeDbInteger(state.sanitizer_version),
    search_index_version: state.search_index_version === null ? null : normalizeDbInteger(state.search_index_version),
    platform_registry_fingerprint: state.platform_registry_fingerprint,
  };
  const expectedFacts = {
    schema_version: expected.schema_version,
    adapter_contract_version: expected.adapter_contract_version,
    shape_signature_version: expected.shape_signature_version,
    filesystem_authority_contract_version: expected.filesystem_authority_contract_version,
    normalizer_version: null,
    sanitizer_version: null,
    search_index_version: null,
    platform_registry_fingerprint: expected.platform_registry_fingerprint,
  };
  if (stableJson(actualFacts) !== stableJson(expectedFacts)) fail("catalog_contract_mismatch", "Catalog state versions or registry fingerprint drifted");
  const actualPlatforms = db.prepare(`SELECT platform_id,family,physical_root,physical_root_key,enabled,adapter_version,shape_policy_version FROM platforms ORDER BY platform_id`).all().map(row => ({
    ...row,
    enabled: normalizeDbInteger(row.enabled),
    adapter_version: normalizeDbInteger(row.adapter_version),
    shape_policy_version: normalizeDbInteger(row.shape_policy_version),
  }));
  const expectedPlatforms = mapPlatformRegistry(platformRoots).slice().sort((left, right) => compareText(left.platform_id, right.platform_id));
  if (stableJson(actualPlatforms) !== stableJson(expectedPlatforms)) fail("catalog_contract_mismatch", "Catalog platform rows drifted from the registry");
  return true;
}

function initializeCatalog(db, { builtAtMs, platformRoots } = {}) {
  createCatalogSchema(db);
  const state = mapCatalogState({ catalogRevision: 0, builtAtMs, platformRoots });
  const platforms = mapPlatformRegistry(platformRoots);
  db.transaction(() => {
    db.prepare(`INSERT INTO catalog_state (
      singleton,schema_version,catalog_revision,built_at_ms,adapter_contract_version,shape_signature_version,filesystem_authority_contract_version,
      normalizer_version,sanitizer_version,search_index_version,platform_registry_fingerprint
    ) VALUES (@singleton,@schema_version,@catalog_revision,@built_at_ms,@adapter_contract_version,@shape_signature_version,@filesystem_authority_contract_version,
      @normalizer_version,@sanitizer_version,@search_index_version,@platform_registry_fingerprint)`).run(state);
    const insert = db.prepare(`INSERT INTO platforms(platform_id,family,physical_root,physical_root_key,enabled,adapter_version,shape_policy_version)
      VALUES (@platform_id,@family,@physical_root,@physical_root_key,@enabled,@adapter_version,@shape_policy_version)`);
    for (const row of platforms) insert.run(row);
  })();
  verifyCatalogContract(db);
  return { state, platforms };
}

function assertNs(value, field, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== "bigint" || value < 0n) fail("invalid_mtime_ns", `${field} must be a non-negative BigInt${nullable ? " or null" : ""}`);
}

function validateMappedCandidate(candidate) {
  if (!candidate || candidate.ok !== true || candidate.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION || !candidate.rows) fail("invalid_mapped_candidate", "Writer only accepts successful Schema v4 mapped candidates");
  const { rows, identities } = candidate;
  if (!rows.work || !rows.author || !identities?.work || !identities?.author) fail("invalid_mapped_candidate", "Mapped candidate physical rows are incomplete");
  if (rows.work.platform_id !== identities.work.platform_id || rows.work.relative_path_key !== identities.work.relative_path_key) fail("invalid_mapped_candidate", "Work physical identity candidate mismatch");
  if (rows.author.platform_id !== identities.author.platform_id || rows.author.relative_path_key !== identities.author.relative_path_key) fail("invalid_mapped_candidate", "Author physical identity candidate mismatch");
  if (rows.work.platform_id !== rows.author.platform_id) fail("invalid_mapped_candidate", "Candidate platform identities disagree");
  assertNs(rows.work.work_dir_mtime_ns, "work.work_dir_mtime_ns", false);
  assertNs(rows.work.metadata_mtime_ns, "work.metadata_mtime_ns");
  if (rows.metadataShape !== null) {
    if (!identities.metadataShape || rows.metadataShape.shape_hash !== identities.metadataShape.shape_hash) fail("invalid_mapped_candidate", "Shape identity candidate mismatch");
  } else if (identities.metadataShape !== null) fail("invalid_mapped_candidate", "Shape identity exists without a row");
  if (rows.authorProfile) {
    assertNs(rows.authorProfile.source_metadata_mtime_ns, "authorProfile.source_metadata_mtime_ns");
    let links;
    try { links = JSON.parse(rows.authorProfile.profile_links_json); } catch { fail("unstable_profile_links_json", "profile_links_json is not valid JSON"); }
    if (stableJson(links) !== rows.authorProfile.profile_links_json) fail("unstable_profile_links_json", "profile_links_json is not canonical stable JSON");
  } else if ((rows.authorAliases || []).length) fail("invalid_mapped_candidate", "Aliases require an authoritative profile candidate");
  if (rows.work.cover_media_id !== null) fail("invalid_mapped_candidate", "Cover selection is writer/runtime owned");
  if (rows.workText && [rows.workText.safe_format, rows.workText.safe_text, rows.workText.plain_text, rows.workText.search_text, rows.workText.normalizer_version, rows.workText.sanitizer_version].some(value => value !== null)) fail("invalid_mapped_candidate", "Derived text layers are not implemented");
  if (!Array.isArray(rows.mediaDeclarations)) fail("invalid_mapped_candidate", "Metadata media declarations are missing");
  validateReconciledMediaPersistence(candidate);
  return candidate;
}

function prepareBatch(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) fail("empty_batch", "Mapped batch must contain at least one candidate");
  const byPhysicalWork = new Map();
  let duplicateCount = 0;
  for (const input of inputs) {
    const candidate = validateMappedCandidate(input);
    const key = naturalKey(candidate.rows.work.platform_id, candidate.rows.work.relative_path_key);
    const canonical = canonicalCandidate(candidate);
    const existing = byPhysicalWork.get(key);
    if (!existing) byPhysicalWork.set(key, { candidate, canonical });
    else if (existing.canonical === canonical) duplicateCount++;
    else fail("conflicting_duplicate_work_candidate", "Conflicting candidates share one physical work identity", { platformId: candidate.rows.work.platform_id, relativePathKey: candidate.rows.work.relative_path_key });
  }
  return {
    duplicateCount,
    candidates: [...byPhysicalWork.values()].map(value => value.candidate).sort((left, right) => compareText(left.rows.work.platform_id, right.rows.work.platform_id)
      || compareText(left.rows.work.relative_path_key, right.rows.work.relative_path_key)),
  };
}

function upsertAuthorStatement(db) {
  return db.prepare(`INSERT INTO authors(
    platform_id,relative_path,relative_path_key,folder_name,source_author_id,source_author_id_source,display_name,display_name_source,
    handle,name_rank,work_count,latest_work_at_ms,latest_work_id,profile_state
  ) VALUES (@platform_id,@relative_path,@relative_path_key,@folder_name,@source_author_id,@source_author_id_source,@display_name,@display_name_source,
    @handle,@name_rank,0,NULL,NULL,@profile_state)
  ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET
    relative_path=excluded.relative_path,folder_name=excluded.folder_name,source_author_id=excluded.source_author_id,
    source_author_id_source=excluded.source_author_id_source,display_name=excluded.display_name,display_name_source=excluded.display_name_source,
    handle=excluded.handle,name_rank=excluded.name_rank,profile_state=excluded.profile_state`);
}

function upsertPhysicalAuthorsCore(db, authorRows, affectedCounts = createAffectedCounts()) {
  if (db.inTransaction !== true) fail("transaction_required", "Physical author core requires an active transaction");
  const upsert = upsertAuthorStatement(db);
  const select = db.prepare("SELECT author_id FROM authors WHERE platform_id=? AND relative_path_key=?");
  const ids = new Map();
  for (const row of authorRows.slice().sort((left, right) => compareText(left.platform_id, right.platform_id) || compareText(left.relative_path_key, right.relative_path_key))) {
    upsert.run(row);
    const authorId = select.get(row.platform_id, row.relative_path_key).author_id;
    affectedCounts.authorIds.add(authorId);
    ids.set(naturalKey(row.platform_id, row.relative_path_key), authorId);
  }
  return ids;
}

function upsertPhysicalAuthors(db, authorRows) {
  assertSafeIntegerConnection(db);
  verifyCatalogContract(db);
  if (!Array.isArray(authorRows)) fail("invalid_author_batch", "authorRows must be an array");
  return db.transaction(() => {
    const affected = createAffectedCounts();
    const ids = upsertPhysicalAuthorsCore(db, authorRows, affected);
    recountAffectedCounts(db, affected);
    return { applied: ids.size };
  })();
}

function upsertShapeRows(db, candidates, observedAtMs, affectedCounts) {
  const insert = db.prepare(`INSERT INTO metadata_shapes(platform_id,signature_version,policy_version,shape_hash,first_seen_at_ms,last_seen_at_ms,work_count,representative_metadata_relative_path)
    VALUES (@platform_id,@signature_version,@policy_version,@shape_hash,@observedAtMs,@observedAtMs,0,@representative_metadata_relative_path)
    ON CONFLICT(platform_id,signature_version,policy_version,shape_hash) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms,
      representative_metadata_relative_path=CASE
        WHEN metadata_shapes.representative_metadata_relative_path IS NULL THEN excluded.representative_metadata_relative_path
        WHEN excluded.representative_metadata_relative_path IS NULL THEN metadata_shapes.representative_metadata_relative_path
        WHEN excluded.representative_metadata_relative_path<metadata_shapes.representative_metadata_relative_path THEN excluded.representative_metadata_relative_path
        ELSE metadata_shapes.representative_metadata_relative_path END`);
  const select = db.prepare("SELECT metadata_shape_id FROM metadata_shapes WHERE platform_id=? AND signature_version=? AND policy_version=? AND shape_hash=?");
  const ids = new Map();
  for (const candidate of candidates) {
    const row = candidate.rows.metadataShape;
    if (!row) continue;
    const key = naturalKey(row.platform_id, row.signature_version, row.policy_version, row.shape_hash);
    if (ids.has(key)) continue;
    insert.run({ ...row, observedAtMs });
    const id = select.get(row.platform_id, row.signature_version, row.policy_version, row.shape_hash).metadata_shape_id;
    ids.set(key, id);
    affectedCounts.shapeIds.add(id);
  }
  return ids;
}

function upsertTags(db, candidates) {
  const insert = db.prepare(`INSERT INTO tags(display_value,normalized_value,work_count) VALUES (@display_value,@normalized_value,0)
    ON CONFLICT(display_value) DO UPDATE SET display_value=excluded.display_value`);
  const select = db.prepare("SELECT tag_id,normalized_value FROM tags WHERE display_value=?");
  const ids = new Map();
  for (const candidate of candidates) for (const row of candidate.rows.tags || []) {
    if (ids.has(row.display_value)) continue;
    insert.run(row);
    const stored = select.get(row.display_value);
    if (stored.normalized_value !== row.normalized_value) fail("conflicting_tag_candidate", "Stored tag normalization conflicts with mapped candidate");
    ids.set(row.display_value, stored.tag_id);
  }
  return ids;
}

function replaceMetadataChildren(db, workId, rows, tagIds, affectedCounts) {
  const deletions = ["work_access", "work_text", "work_text_sources", "structured_sources", "field_sources", "work_tags", "social_relations", "work_metrics"];
  for (const table of deletions) db.prepare(`DELETE FROM ${table} WHERE work_id=?`).run(workId);
  if (rows.workAccess) db.prepare("INSERT INTO work_access(work_id,current_user_can_view,minimum_cents_pledged_to_view) VALUES (@work_id,@current_user_can_view,@minimum_cents_pledged_to_view)").run({ ...rows.workAccess, work_id: workId });
  if (rows.workText) db.prepare(`INSERT INTO work_text(work_id,source_format,source_text,safe_format,safe_text,plain_text,search_text,normalizer_version,sanitizer_version)
    VALUES (@work_id,@source_format,@source_text,@safe_format,@safe_text,@plain_text,@search_text,@normalizer_version,@sanitizer_version)`).run({ ...rows.workText, work_id: workId });
  const insertText = db.prepare("INSERT INTO work_text_sources(work_id,ordinal,role,source_path,source_format,source_text) VALUES (@work_id,@ordinal,@role,@source_path,@source_format,@source_text)");
  for (const row of rows.textSources || []) insertText.run({ ...row, work_id: workId });
  const insertStructured = db.prepare("INSERT INTO structured_sources(work_id,ordinal,role,source_path,encoding,source_text,schema_hint) VALUES (@work_id,@ordinal,@role,@source_path,@encoding,@source_text,@schema_hint)");
  for (const row of rows.structuredSources || []) insertStructured.run({ ...row, work_id: workId });
  const insertField = db.prepare("INSERT INTO field_sources(work_id,field,source_kind,source_path,priority) VALUES (@work_id,@field,@source_kind,@source_path,@priority)");
  for (const row of rows.fieldSources || []) insertField.run({ ...row, work_id: workId });
  const insertTag = db.prepare("INSERT INTO work_tags(tag_id,work_id,ordinal,sort_at_ms) VALUES (@tag_id,@work_id,@ordinal,@sort_at_ms)");
  for (let index = 0; index < (rows.tags || []).length; index++) {
    const tagId = tagIds.get(rows.tags[index].display_value);
    affectedCounts.tagIds.add(tagId);
    insertTag.run({ ...rows.workTags[index], tag_id: tagId, work_id: workId });
  }
  const target = db.prepare("SELECT work_id FROM works WHERE platform_id=? AND source_work_id=? ORDER BY work_id LIMIT 2");
  const insertRelation = db.prepare("INSERT INTO social_relations(work_id,ordinal,relation_type,target_platform_id,target_source_work_id,target_work_id) VALUES (@work_id,@ordinal,@relation_type,@target_platform_id,@target_source_work_id,@target_work_id)");
  for (const row of rows.relations || []) {
    const matches = target.all(row.target_platform_id, row.target_source_work_id);
    insertRelation.run({ ...row, work_id: workId, target_work_id: matches.length === 1 ? matches[0].work_id : null });
  }
  db.prepare("INSERT INTO work_metrics(work_id,likes,replies,comments,reposts,views,bookmarks) VALUES (@work_id,@likes,@replies,@comments,@reposts,@views,@bookmarks)").run({ ...rows.metrics, work_id: workId });
}

function persistActualMedia(db, workId, authority) {
  db.prepare("UPDATE works SET cover_media_id=NULL WHERE work_id=?").run(workId);
  if (authority.filesystemFilesState === "complete") {
    db.prepare("DELETE FROM media_declarations WHERE work_id=?").run(workId);
    db.prepare("DELETE FROM media WHERE work_id=?").run(workId);
  }
  const insertMedia = db.prepare(`INSERT INTO media(
    work_id,relative_path,relative_path_key,filesystem_file_name,filesystem_extension,filesystem_size,filesystem_mtime_ns,filesystem_media_type,
    source_media_id,metadata_ordinal,metadata_name,metadata_media_type,declared_size,remote_url,source_hash,duration_ms
  ) VALUES (@work_id,@relative_path,@relative_path_key,@filesystem_file_name,@filesystem_extension,@filesystem_size,@filesystem_mtime_ns,@filesystem_media_type,
    @source_media_id,@metadata_ordinal,@metadata_name,@metadata_media_type,@declared_size,@remote_url,@source_hash,@duration_ms)
  ON CONFLICT(work_id,relative_path_key) DO UPDATE SET
    relative_path=excluded.relative_path,filesystem_file_name=excluded.filesystem_file_name,filesystem_extension=excluded.filesystem_extension,
    filesystem_size=excluded.filesystem_size,filesystem_mtime_ns=excluded.filesystem_mtime_ns,filesystem_media_type=excluded.filesystem_media_type,
    source_media_id=excluded.source_media_id,metadata_ordinal=excluded.metadata_ordinal,metadata_name=excluded.metadata_name,
    metadata_media_type=excluded.metadata_media_type,declared_size=excluded.declared_size,remote_url=excluded.remote_url,source_hash=excluded.source_hash,duration_ms=excluded.duration_ms`);
  const selectMedia = db.prepare("SELECT media_id FROM media WHERE work_id=? AND relative_path_key=?");
  const mediaIds = new Map();
  for (const row of authority.actualMediaRows) {
    insertMedia.run({ ...row, work_id: workId });
    mediaIds.set(row.relative_path_key, selectMedia.get(workId, row.relative_path_key).media_id);
  }
  const insertDeclaration = db.prepare(`INSERT INTO media_declarations(
    work_id,ordinal,source_media_id,declared_name,declared_media_type,declared_size,remote_url,source_hash,duration_ms,match_state,matched_media_id
  ) VALUES (@work_id,@ordinal,@source_media_id,@declared_name,@declared_media_type,@declared_size,@remote_url,@source_hash,@duration_ms,@match_state,@matched_media_id)
  ON CONFLICT(work_id,ordinal) DO UPDATE SET source_media_id=excluded.source_media_id,declared_name=excluded.declared_name,
    declared_media_type=excluded.declared_media_type,declared_size=excluded.declared_size,remote_url=excluded.remote_url,
    source_hash=excluded.source_hash,duration_ms=excluded.duration_ms,match_state=excluded.match_state,matched_media_id=excluded.matched_media_id`);
  for (const row of authority.declarationRows) {
    insertDeclaration.run({
      work_id: workId,
      ordinal: row.ordinal,
      source_media_id: row.source_media_id,
      declared_name: row.declared_name,
      declared_media_type: row.declared_media_type,
      declared_size: row.declared_size,
      remote_url: row.remote_url,
      source_hash: row.source_hash,
      duration_ms: row.duration_ms,
      match_state: row.match_state,
      matched_media_id: row.match_state === "matched" ? mediaIds.get(row.matched_filesystem_relative_path_key) : null,
    });
  }
  const counts = db.prepare(`SELECT count(*) AS media_count,
    count(*) FILTER (WHERE filesystem_media_type='image') AS image_count,
    count(*) FILTER (WHERE filesystem_media_type='video') AS video_count FROM media WHERE work_id=?`).get(workId);
  db.prepare("UPDATE works SET media_count=?,image_count=?,video_count=? WHERE work_id=?").run(counts.media_count, counts.image_count, counts.video_count, workId);
}

function applyProfiles(db, candidates, authorIds, shapeIds) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = naturalKey(candidate.rows.author.platform_id, candidate.rows.author.relative_path_key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const deleteProfile = db.prepare("DELETE FROM author_profiles WHERE author_id=?");
  const deleteAliases = db.prepare("DELETE FROM author_aliases WHERE author_id=?");
  const insertProfile = db.prepare(`INSERT INTO author_profiles(
    author_id,bio,avatar_url,banner_url,profile_url,location,language,verified,verification_type,verification_reason,
    followers_count,following_count,statuses_count,profile_links_json,authority_work_id,source_published_at_ms,source_metadata_mtime_ns,adapter_version,metadata_shape_id
  ) VALUES (@author_id,@bio,@avatar_url,@banner_url,@profile_url,@location,@language,@verified,@verification_type,@verification_reason,
    @followers_count,@following_count,@statuses_count,@profile_links_json,@authority_work_id,@source_published_at_ms,@source_metadata_mtime_ns,@adapter_version,@metadata_shape_id)`);
  const insertAlias = db.prepare("INSERT INTO author_aliases(author_id,platform_id,alias_kind,display_value,normalized_value) VALUES (@author_id,@platform_id,@alias_kind,@display_value,@normalized_value)");
  const selectWork = db.prepare("SELECT work_id,sort_at_ms FROM works WHERE platform_id=? AND relative_path_key=?");
  const updateValid = db.prepare("UPDATE authors SET latest_work_id=?,latest_work_at_ms=?,profile_state='valid' WHERE author_id=?");
  const clear = db.prepare("UPDATE authors SET latest_work_id=NULL,latest_work_at_ms=NULL,profile_state=? WHERE author_id=?");
  for (const [key, group] of groups) {
    const authorId = authorIds.get(key);
    deleteProfile.run(authorId);
    deleteAliases.run(authorId);
    const authority = group.find(candidate => candidate.rows.authorProfile) || null;
    const finalCandidate = group.find(candidate => candidate.authorAuthorityFinal === true) || group[0];
    if (!authority) {
      if (finalCandidate.rows.author.profile_state === "valid") continue;
      clear.run(finalCandidate.rows.author.profile_state, authorId);
      continue;
    }
    const work = selectWork.get(authority.rows.work.platform_id, authority.rows.work.relative_path_key);
    const shape = authority.rows.metadataShape;
    const shapeId = shape ? shapeIds.get(naturalKey(shape.platform_id, shape.signature_version, shape.policy_version, shape.shape_hash)) : null;
    insertProfile.run({ ...authority.rows.authorProfile, author_id: authorId, authority_work_id: work.work_id, metadata_shape_id: shapeId });
    for (const alias of authority.rows.authorAliases || []) insertAlias.run({ ...alias, author_id: authorId });
    updateValid.run(work.work_id, work.sort_at_ms, authorId);
  }
}

function applyMappedBatchCore(db, mappedCandidates, transactionContext, affectedCounts = createAffectedCounts()) {
  assertSafeIntegerConnection(db);
  if (db.inTransaction !== true) fail("transaction_required", "Catalog mapped batch core requires an active transaction");
  const { observedAtMs } = validateTransactionContext(transactionContext);
  const prepared = prepareBatch(mappedCandidates);
  const shapeIds = upsertShapeRows(db, prepared.candidates, observedAtMs, affectedCounts);
  const authorRows = [];
  const authorByKey = new Map();
  for (const candidate of prepared.candidates) {
    const row = candidate.rows.author;
    const key = naturalKey(row.platform_id, row.relative_path_key);
    const canonical = canonicalCandidate(row);
    const existing = authorByKey.get(key);
    if (!existing) {
      authorByKey.set(key, { canonical, final: candidate.authorAuthorityFinal === true, row, rowIndex: authorRows.length });
      authorRows.push(row);
    } else if (candidate.authorAuthorityFinal === true) {
      authorRows[existing.rowIndex] = row;
      authorByKey.set(key, { canonical, final: true, row, rowIndex: existing.rowIndex });
    } else if (!existing.final && existing.canonical !== canonical) {
      fail("conflicting_physical_author_candidate", "One physical author received conflicting non-authoritative facts");
    }
  }
  const authorIds = upsertPhysicalAuthorsCore(db, authorRows, affectedCounts);
  const tagIds = upsertTags(db, prepared.candidates);
  const selectExisting = db.prepare("SELECT work_id,author_id,metadata_shape_id FROM works WHERE platform_id=? AND relative_path_key=?");
  const upsertWork = db.prepare(`INSERT INTO works(
    platform_id,author_id,relative_path,relative_path_key,source_work_id,source_work_id_source,published_at_ms,updated_at_ms,sort_at_ms,sort_time_source,
    title,title_source,title_rank,language,is_adult,is_ai_generated,is_paid,is_restricted,is_sensitive,has_full,is_advertisement,
    image_count,video_count,media_count,cover_media_id,filesystem_state,filesystem_files_state,work_dir_mtime_ns,metadata_state,enrichment_state,
    metadata_mtime_ns,metadata_size,adapter_version,metadata_shape_id
  ) VALUES (@platform_id,@author_id,@relative_path,@relative_path_key,@source_work_id,@source_work_id_source,@published_at_ms,@updated_at_ms,@sort_at_ms,@sort_time_source,
    @title,@title_source,@title_rank,@language,@is_adult,@is_ai_generated,@is_paid,@is_restricted,@is_sensitive,@has_full,@is_advertisement,
    0,0,0,NULL,@filesystem_state,@filesystem_files_state,@work_dir_mtime_ns,@metadata_state,@enrichment_state,@metadata_mtime_ns,@metadata_size,@adapter_version,@metadata_shape_id)
  ON CONFLICT(platform_id,relative_path_key) DO UPDATE SET
    author_id=excluded.author_id,relative_path=excluded.relative_path,source_work_id=excluded.source_work_id,source_work_id_source=excluded.source_work_id_source,
    published_at_ms=excluded.published_at_ms,updated_at_ms=excluded.updated_at_ms,sort_at_ms=excluded.sort_at_ms,sort_time_source=excluded.sort_time_source,
    title=excluded.title,title_source=excluded.title_source,title_rank=excluded.title_rank,language=excluded.language,
    is_adult=excluded.is_adult,is_ai_generated=excluded.is_ai_generated,is_paid=excluded.is_paid,is_restricted=excluded.is_restricted,
    is_sensitive=excluded.is_sensitive,has_full=excluded.has_full,is_advertisement=excluded.is_advertisement,
    filesystem_state=excluded.filesystem_state,filesystem_files_state=excluded.filesystem_files_state,work_dir_mtime_ns=excluded.work_dir_mtime_ns,
    metadata_state=excluded.metadata_state,enrichment_state=excluded.enrichment_state,metadata_mtime_ns=excluded.metadata_mtime_ns,
    metadata_size=excluded.metadata_size,adapter_version=excluded.adapter_version,metadata_shape_id=excluded.metadata_shape_id`);
  const appliedWorks = [];
  for (const candidate of prepared.candidates) {
    const rows = candidate.rows;
    const authority = validateReconciledMediaPersistence(candidate);
    if (!authority) fail("filesystem_media_authority_required", "Writer requires Filesystem Observation persistence authority");
    const authorId = authorIds.get(naturalKey(rows.author.platform_id, rows.author.relative_path_key));
    const shape = rows.metadataShape;
    const shapeId = shape ? shapeIds.get(naturalKey(shape.platform_id, shape.signature_version, shape.policy_version, shape.shape_hash)) : null;
    const existing = selectExisting.get(rows.work.platform_id, rows.work.relative_path_key);
    if (existing) {
      affectedCounts.authorIds.add(existing.author_id);
      if (existing.metadata_shape_id !== null) affectedCounts.shapeIds.add(existing.metadata_shape_id);
      for (const row of db.prepare("SELECT tag_id FROM work_tags WHERE work_id=?").all(existing.work_id)) affectedCounts.tagIds.add(row.tag_id);
    }
    upsertWork.run({ ...rows.work, author_id: authorId, metadata_shape_id: shapeId });
    const workId = selectExisting.get(rows.work.platform_id, rows.work.relative_path_key).work_id;
    affectedCounts.authorIds.add(authorId);
    if (shapeId !== null) affectedCounts.shapeIds.add(shapeId);
    replaceMetadataChildren(db, workId, rows, tagIds, affectedCounts);
    persistActualMedia(db, workId, authority);
    appliedWorks.push({ platformId: rows.work.platform_id, relativePathKey: rows.work.relative_path_key, sourceWorkId: rows.work.source_work_id, authorId, workId, shapeId });
  }
  applyProfiles(db, prepared.candidates, authorIds, shapeIds);
  return { applied: appliedWorks.length, deduplicated: prepared.duplicateCount, works: appliedWorks };
}

function backfillUniqueRelationTargets(db) {
  db.prepare(`UPDATE social_relations SET target_work_id=NULL WHERE target_work_id IS NOT NULL AND
    (SELECT count(*) FROM works w WHERE w.platform_id=social_relations.target_platform_id AND w.source_work_id=social_relations.target_source_work_id)<>1`).run();
  db.prepare(`UPDATE social_relations SET target_work_id=(
    SELECT min(w.work_id) FROM works w WHERE w.platform_id=social_relations.target_platform_id AND w.source_work_id=social_relations.target_source_work_id
    HAVING count(*)=1
  ) WHERE target_work_id IS NULL`).run();
}

function finalizeCatalogWrites(db, affectedCounts) {
  if (db.inTransaction !== true) fail("transaction_required", "Catalog finalization requires an active transaction");
  recountAffectedCounts(db, affectedCounts);
  backfillUniqueRelationTargets(db);
  const foreignKeys = db.pragma("foreign_key_check");
  if (foreignKeys.length) fail("catalog_integrity_failure", "foreign_key_check failed after Catalog writes", foreignKeys);
}

function applyMappedBatch(db, mappedCandidates, transactionContext) {
  assertSafeIntegerConnection(db);
  validateTransactionContext(transactionContext);
  verifyCatalogContract(db);
  return db.transaction(() => {
    const affected = createAffectedCounts();
    const result = applyMappedBatchCore(db, mappedCandidates, transactionContext, affected);
    finalizeCatalogWrites(db, affected);
    return result;
  })();
}

module.exports = {
  CatalogWriterError,
  applyMappedBatch,
  applyMappedBatchCore,
  finalizeCatalogWrites,
  initializeCatalog,
  upsertPhysicalAuthors,
  upsertPhysicalAuthorsCore,
  validateTransactionContext,
  verifyCatalogContract,
};
