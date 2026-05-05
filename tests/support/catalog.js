"use strict";

const Database = require("./sqlite.js").Database;

const { INDEX_NAMES, TABLE_NAMES, createCatalogSchema } = require("../../internal/catalog/schema.js");
const { mapCatalogState, mapPlatformRegistry } = require("../../internal/catalog/mapping.js");

function openCatalog() {
  const db = new Database(":memory:");
  createCatalogSchema(db);
  return db;
}

function insertCatalogState(db, options = {}) {
  const row = mapCatalogState({ catalogRevision: 0, builtAtMs: 1700000000000, platformRoots: require("./sources.js").sources(), ...options });
  db.prepare(`INSERT INTO catalog_state (
    singleton,schema_version,catalog_revision,built_at_ms,adapter_contract_version,shape_signature_version,filesystem_authority_contract_version,
    normalizer_version,sanitizer_version,search_index_version,platform_registry_fingerprint
  ) VALUES (@singleton,@schema_version,@catalog_revision,@built_at_ms,@adapter_contract_version,@shape_signature_version,@filesystem_authority_contract_version,
    @normalizer_version,@sanitizer_version,@search_index_version,@platform_registry_fingerprint)`).run(row);
  return row;
}

function insertPlatforms(db) {
  const insert = db.prepare(`INSERT INTO platforms (
    platform_id,family,physical_root,physical_root_key,enabled,adapter_version,shape_policy_version
  ) VALUES (@platform_id,@family,@physical_root,@physical_root_key,@enabled,@adapter_version,@shape_policy_version)`);
  const rows = mapPlatformRegistry(require("./sources.js").sources());
  db.transaction(values => values.forEach(value => insert.run(value)))(rows);
  return rows;
}

function insertShape(db, platformId = "pixiv", hash = "a".repeat(64)) {
  const info = db.prepare(`INSERT INTO metadata_shapes (
    platform_id,signature_version,policy_version,shape_hash,first_seen_at_ms,last_seen_at_ms,work_count,representative_metadata_relative_path
  ) VALUES (?,1,1,?,NULL,NULL,0,NULL)`).run(platformId, hash);
  return info.lastInsertRowid;
}

function insertAuthor(db, platformId, sourceAuthorId, suffix = "") {
  const folder = `${sourceAuthorId}${suffix}`;
  const info = db.prepare(`INSERT INTO authors (
    platform_id,relative_path,relative_path_key,folder_name,source_author_id,source_author_id_source,display_name,display_name_source,
    handle,name_rank,work_count,latest_work_at_ms,latest_work_id,profile_state
  ) VALUES (?,?,?,?,?,'metadata',?,'directory_raw',NULL,NULL,0,NULL,NULL,'unavailable')`).run(platformId, folder, folder.toLowerCase(), folder, `${sourceAuthorId}${suffix}`, folder);
  return info.lastInsertRowid;
}

function insertWork(db, { platformId = "pixiv", sourceWorkId, authorId = null, relativePath, publishedAtMs = null, shapeId = null }) {
  const info = db.prepare(`INSERT INTO works (
    platform_id,source_work_id,source_work_id_source,author_id,relative_path,relative_path_key,published_at_ms,updated_at_ms,sort_at_ms,sort_time_source,title,title_source,title_rank,language,
    is_adult,is_ai_generated,is_paid,is_restricted,is_sensitive,has_full,is_advertisement,
    image_count,video_count,media_count,cover_media_id,filesystem_state,filesystem_files_state,work_dir_mtime_ns,metadata_state,enrichment_state,
    metadata_mtime_ns,metadata_size,adapter_version,metadata_shape_id
  ) VALUES (?,?,'metadata',?,?,?,?,NULL,?,'metadata_published',?,'directory_raw',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,NULL,'present','complete',1,'valid','available',NULL,NULL,1,?)`)
    .run(platformId, sourceWorkId, authorId, relativePath, relativePath.toLowerCase(), publishedAtMs, publishedAtMs ?? 0, relativePath.split(/[\\/]/).at(-1), shapeId);
  return info.lastInsertRowid;
}

function normalizePragmaValue(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalizePragmaValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePragmaValue(item)]));
  return value;
}

function schemaSnapshot(db) {
  const tables = {};
  for (const table of TABLE_NAMES) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    const columns = normalizePragmaValue(db.pragma(`table_xinfo(${table})`)).map(({ cid, name, type, notnull, dflt_value, pk, hidden }) => ({ cid, name, type, notnull, dflt_value, pk, hidden }));
    const foreignKeys = normalizePragmaValue(db.pragma(`foreign_key_list(${table})`)).map(({ id, seq, table: parent, from, to, on_update, on_delete, match }) => ({ id, seq, table: parent, from, to, on_update, on_delete, match }));
    const indexes = normalizePragmaValue(db.pragma(`index_list(${table})`)).map(({ name, unique, origin, partial }) => ({
      name,
      unique,
      origin,
      partial,
      columns: normalizePragmaValue(db.pragma(`index_xinfo(${name})`)).map(({ seqno, cid, name: column, desc, coll, key }) => ({ seqno, cid, name: column, desc, coll, key })),
    }));
    tables[table] = { sql, columns, foreignKeys, indexes };
  }
  return { tables, expectedExplicitIndexes: INDEX_NAMES };
}

module.exports = {
  insertAuthor,
  insertCatalogState,
  insertPlatforms,
  insertShape,
  insertWork,
  openCatalog,
  schemaSnapshot,
};
