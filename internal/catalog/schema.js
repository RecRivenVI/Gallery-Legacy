"use strict";

const { PLATFORM_REGISTRY } = require("../library/platforms.js");

const CATALOG_SCHEMA_VERSION = 4;

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const PLATFORM_ID_CHECK = PLATFORM_REGISTRY.map(entry => sqlString(entry.id)).join(", ");

const TABLE_NAMES = Object.freeze([
  "author_aliases", "author_profiles", "authors", "catalog_state", "field_sources", "media",
  "media_declarations", "metadata_shapes", "platforms", "social_relations", "structured_sources", "tags",
  "work_access", "work_metrics", "work_tags", "work_text", "work_text_sources", "works",
]);

const INDEX_NAMES = Object.freeze([
  "idx_authors_source_identity", "idx_media_declarations_match_state", "idx_social_relations_unresolved_target",
  "idx_work_tags_tag_sort", "idx_works_author_sort", "idx_works_metadata_shape", "idx_works_platform_sort",
  "idx_works_sort", "idx_works_source_identity", "uq_authors_internal_platform", "uq_authors_relative_path",
  "uq_field_sources_evidence", "uq_media_declarations_ordinal", "uq_media_declarations_single_match",
  "uq_media_work_pair", "uq_media_work_relative_path_key", "uq_metadata_shapes_identity",
  "uq_platforms_physical_root_key", "uq_social_relations_ordinal", "uq_social_relations_target",
  "uq_structured_sources_ordinal", "uq_tags_display_value", "uq_tags_normalized_value",
  "uq_work_tags_work_ordinal", "uq_work_text_sources_ordinal", "uq_works_relative_path",
]);

const SCHEMA_SQL = `
CREATE TABLE catalog_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = ${CATALOG_SCHEMA_VERSION}),
  catalog_revision INTEGER NOT NULL CHECK (typeof(catalog_revision) = 'integer' AND catalog_revision >= 0),
  built_at_ms INTEGER NOT NULL CHECK (typeof(built_at_ms) = 'integer' AND built_at_ms >= 0),
  adapter_contract_version INTEGER NOT NULL CHECK (adapter_contract_version >= 1),
  shape_signature_version INTEGER NOT NULL CHECK (shape_signature_version >= 1),
  filesystem_authority_contract_version INTEGER NOT NULL CHECK (filesystem_authority_contract_version >= 1),
  normalizer_version INTEGER CHECK (normalizer_version IS NULL OR normalizer_version >= 1),
  sanitizer_version INTEGER CHECK (sanitizer_version IS NULL OR sanitizer_version >= 1),
  search_index_version INTEGER CHECK (search_index_version IS NULL OR search_index_version >= 1),
  platform_registry_fingerprint TEXT NOT NULL CHECK (typeof(platform_registry_fingerprint) = 'text' AND length(platform_registry_fingerprint) = 64)
);

CREATE TABLE platforms (
  platform_id TEXT PRIMARY KEY CHECK (typeof(platform_id) = 'text' AND platform_id IN (${PLATFORM_ID_CHECK})),
  family TEXT NOT NULL CHECK (typeof(family) = 'text' AND length(family) > 0),
  physical_root TEXT NOT NULL CHECK (typeof(physical_root) = 'text' AND length(physical_root) > 0),
  physical_root_key TEXT NOT NULL CHECK (typeof(physical_root_key) = 'text' AND length(physical_root_key) > 0),
  enabled INTEGER NOT NULL CHECK (typeof(enabled) = 'integer' AND enabled IN (0, 1)),
  adapter_version INTEGER NOT NULL CHECK (typeof(adapter_version) = 'integer' AND adapter_version >= 1),
  shape_policy_version INTEGER NOT NULL CHECK (typeof(shape_policy_version) = 'integer' AND shape_policy_version >= 1)
);
CREATE UNIQUE INDEX uq_platforms_physical_root_key ON platforms(physical_root_key);

CREATE TABLE metadata_shapes (
  metadata_shape_id INTEGER PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(platform_id) ON DELETE RESTRICT,
  signature_version INTEGER NOT NULL CHECK (typeof(signature_version) = 'integer' AND signature_version >= 1),
  policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version >= 1),
  shape_hash TEXT NOT NULL CHECK (typeof(shape_hash) = 'text' AND length(shape_hash) = 64),
  first_seen_at_ms INTEGER CHECK (first_seen_at_ms IS NULL OR (typeof(first_seen_at_ms) = 'integer' AND first_seen_at_ms >= 0)),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR (typeof(last_seen_at_ms) = 'integer' AND last_seen_at_ms >= 0)),
  work_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(work_count) = 'integer' AND work_count >= 0),
  representative_metadata_relative_path TEXT
);
CREATE UNIQUE INDEX uq_metadata_shapes_identity ON metadata_shapes(platform_id, signature_version, policy_version, shape_hash);

CREATE TABLE authors (
  author_id INTEGER PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(platform_id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL CHECK (typeof(relative_path) = 'text' AND length(relative_path) > 0),
  relative_path_key TEXT NOT NULL CHECK (typeof(relative_path_key) = 'text' AND length(relative_path_key) > 0),
  folder_name TEXT NOT NULL CHECK (typeof(folder_name) = 'text' AND length(folder_name) > 0),
  source_author_id TEXT CHECK (source_author_id IS NULL OR (typeof(source_author_id) = 'text' AND length(source_author_id) > 0)),
  source_author_id_source TEXT CHECK (source_author_id_source IS NULL OR source_author_id_source IN ('metadata','directory_parsed')),
  display_name TEXT NOT NULL CHECK (typeof(display_name) = 'text' AND length(display_name) > 0),
  display_name_source TEXT NOT NULL CHECK (display_name_source IN ('metadata','directory_parsed','directory_raw')),
  handle TEXT,
  name_rank INTEGER,
  work_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(work_count) = 'integer' AND work_count >= 0),
  latest_work_at_ms INTEGER CHECK (latest_work_at_ms IS NULL OR typeof(latest_work_at_ms) = 'integer'),
  latest_work_id INTEGER REFERENCES works(work_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  profile_state TEXT NOT NULL CHECK (profile_state IN ('valid','invalid','unavailable'))
);
CREATE UNIQUE INDEX uq_authors_relative_path ON authors(platform_id, relative_path_key);
CREATE UNIQUE INDEX uq_authors_internal_platform ON authors(author_id, platform_id);
CREATE INDEX idx_authors_source_identity ON authors(platform_id, source_author_id) WHERE source_author_id IS NOT NULL;

CREATE TABLE works (
  work_id INTEGER PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(platform_id) ON DELETE RESTRICT,
  author_id INTEGER NOT NULL REFERENCES authors(author_id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL CHECK (typeof(relative_path) = 'text' AND length(relative_path) > 0),
  relative_path_key TEXT NOT NULL CHECK (typeof(relative_path_key) = 'text' AND length(relative_path_key) > 0),
  source_work_id TEXT CHECK (source_work_id IS NULL OR (typeof(source_work_id) = 'text' AND length(source_work_id) > 0)),
  source_work_id_source TEXT CHECK (source_work_id_source IS NULL OR source_work_id_source IN ('metadata','directory_parsed')),
  published_at_ms INTEGER CHECK (published_at_ms IS NULL OR typeof(published_at_ms) = 'integer'),
  updated_at_ms INTEGER CHECK (updated_at_ms IS NULL OR typeof(updated_at_ms) = 'integer'),
  sort_at_ms INTEGER NOT NULL CHECK (typeof(sort_at_ms) = 'integer'),
  sort_time_source TEXT NOT NULL CHECK (sort_time_source IN ('metadata_published','directory_parsed','directory_mtime')),
  title TEXT NOT NULL CHECK (typeof(title) = 'text' AND length(title) > 0),
  title_source TEXT NOT NULL CHECK (title_source IN ('metadata','directory_parsed','directory_raw')),
  title_rank INTEGER,
  language TEXT,
  is_adult INTEGER CHECK (is_adult IS NULL OR (typeof(is_adult) = 'integer' AND is_adult IN (0, 1))),
  is_ai_generated INTEGER CHECK (is_ai_generated IS NULL OR (typeof(is_ai_generated) = 'integer' AND is_ai_generated IN (0, 1))),
  is_paid INTEGER CHECK (is_paid IS NULL OR (typeof(is_paid) = 'integer' AND is_paid IN (0, 1))),
  is_restricted INTEGER CHECK (is_restricted IS NULL OR (typeof(is_restricted) = 'integer' AND is_restricted IN (0, 1))),
  is_sensitive INTEGER CHECK (is_sensitive IS NULL OR (typeof(is_sensitive) = 'integer' AND is_sensitive IN (0, 1))),
  has_full INTEGER CHECK (has_full IS NULL OR (typeof(has_full) = 'integer' AND has_full IN (0, 1))),
  is_advertisement INTEGER CHECK (is_advertisement IS NULL OR (typeof(is_advertisement) = 'integer' AND is_advertisement IN (0, 1))),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(image_count) = 'integer' AND image_count >= 0),
  video_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(video_count) = 'integer' AND video_count >= 0),
  media_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(media_count) = 'integer' AND media_count >= 0),
  cover_media_id INTEGER,
  filesystem_state TEXT NOT NULL CHECK (filesystem_state IN ('present','unreadable')),
  filesystem_files_state TEXT NOT NULL CHECK (filesystem_files_state IN ('complete','incomplete')),
  work_dir_mtime_ns INTEGER NOT NULL CHECK (typeof(work_dir_mtime_ns) = 'integer' AND work_dir_mtime_ns >= 0),
  metadata_state TEXT NOT NULL CHECK (metadata_state IN ('valid','partial','missing','malformed','non_object','unreadable','unstable')),
  enrichment_state TEXT NOT NULL CHECK (enrichment_state IN ('available','partial','unavailable')),
  metadata_mtime_ns INTEGER CHECK (metadata_mtime_ns IS NULL OR (typeof(metadata_mtime_ns) = 'integer' AND metadata_mtime_ns >= 0)),
  metadata_size INTEGER CHECK (metadata_size IS NULL OR (typeof(metadata_size) = 'integer' AND metadata_size >= 0)),
  adapter_version INTEGER NOT NULL CHECK (typeof(adapter_version) = 'integer' AND adapter_version >= 1),
  metadata_shape_id INTEGER REFERENCES metadata_shapes(metadata_shape_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_id, cover_media_id) REFERENCES media(work_id, media_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX uq_works_relative_path ON works(platform_id, relative_path_key);
CREATE INDEX idx_works_source_identity ON works(platform_id, source_work_id) WHERE source_work_id IS NOT NULL;
CREATE INDEX idx_works_platform_sort ON works(platform_id, sort_at_ms DESC, work_id DESC);
CREATE INDEX idx_works_author_sort ON works(author_id, sort_at_ms DESC, work_id DESC);
CREATE INDEX idx_works_metadata_shape ON works(metadata_shape_id) WHERE metadata_shape_id IS NOT NULL;
CREATE INDEX idx_works_sort ON works(sort_at_ms DESC, work_id DESC);

CREATE TABLE author_profiles (
  author_id INTEGER PRIMARY KEY REFERENCES authors(author_id) ON DELETE CASCADE,
  bio TEXT, avatar_url TEXT, banner_url TEXT, profile_url TEXT, location TEXT, language TEXT,
  verified INTEGER CHECK (verified IS NULL OR (typeof(verified) = 'integer' AND verified IN (0, 1))),
  verification_type INTEGER, verification_reason TEXT,
  followers_count INTEGER CHECK (followers_count IS NULL OR (typeof(followers_count) = 'integer' AND followers_count >= 0)),
  following_count INTEGER CHECK (following_count IS NULL OR (typeof(following_count) = 'integer' AND following_count >= 0)),
  statuses_count INTEGER CHECK (statuses_count IS NULL OR (typeof(statuses_count) = 'integer' AND statuses_count >= 0)),
  profile_links_json TEXT NOT NULL,
  authority_work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  source_published_at_ms INTEGER CHECK (source_published_at_ms IS NULL OR typeof(source_published_at_ms) = 'integer'),
  source_metadata_mtime_ns INTEGER CHECK (source_metadata_mtime_ns IS NULL OR (typeof(source_metadata_mtime_ns) = 'integer' AND source_metadata_mtime_ns >= 0)),
  adapter_version INTEGER NOT NULL CHECK (adapter_version >= 1),
  metadata_shape_id INTEGER REFERENCES metadata_shapes(metadata_shape_id) ON DELETE RESTRICT
);

CREATE TABLE author_aliases (
  author_id INTEGER NOT NULL, platform_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('display_name', 'handle')),
  display_value TEXT NOT NULL CHECK (typeof(display_value) = 'text' AND length(display_value) > 0), normalized_value TEXT,
  FOREIGN KEY (author_id, platform_id) REFERENCES authors(author_id, platform_id) ON DELETE CASCADE,
  PRIMARY KEY (author_id, alias_kind, display_value)
) WITHOUT ROWID;

CREATE TABLE work_access (
  work_id INTEGER PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  current_user_can_view INTEGER CHECK (current_user_can_view IS NULL OR (typeof(current_user_can_view) = 'integer' AND current_user_can_view IN (0, 1))),
  minimum_cents_pledged_to_view INTEGER CHECK (minimum_cents_pledged_to_view IS NULL OR (typeof(minimum_cents_pledged_to_view) = 'integer' AND minimum_cents_pledged_to_view >= 0)),
  CHECK (current_user_can_view IS NOT NULL OR minimum_cents_pledged_to_view IS NOT NULL)
);

CREATE TABLE work_text (
  work_id INTEGER PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  source_format TEXT CHECK (source_format IS NULL OR source_format IN ('plain', 'html', 'markdown')), source_text TEXT,
  safe_format TEXT CHECK (safe_format IS NULL OR safe_format IN ('plain', 'html', 'markdown')), safe_text TEXT,
  plain_text TEXT, search_text TEXT,
  normalizer_version INTEGER CHECK (normalizer_version IS NULL OR normalizer_version >= 1),
  sanitizer_version INTEGER CHECK (sanitizer_version IS NULL OR sanitizer_version >= 1),
  CHECK ((source_format IS NULL) = (source_text IS NULL)), CHECK ((safe_format IS NULL) = (safe_text IS NULL))
);

CREATE TABLE work_text_sources (
  text_source_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0), role TEXT NOT NULL, source_path TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('plain', 'html', 'markdown')), source_text TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_work_text_sources_ordinal ON work_text_sources(work_id, ordinal);

CREATE TABLE structured_sources (
  structured_source_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0), role TEXT NOT NULL, source_path TEXT NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding IN ('json_text', 'opaque_text')), source_text TEXT NOT NULL, schema_hint TEXT
);
CREATE UNIQUE INDEX uq_structured_sources_ordinal ON structured_sources(work_id, ordinal);

CREATE TABLE field_sources (
  field_source_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  field TEXT NOT NULL, source_kind TEXT NOT NULL CHECK (source_kind IN ('filesystem', 'metadata')), source_path TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (typeof(priority) = 'integer' AND priority >= 1)
);
CREATE UNIQUE INDEX uq_field_sources_evidence ON field_sources(work_id, field, source_kind, source_path, priority);

CREATE TABLE media (
  media_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL CHECK (typeof(relative_path) = 'text' AND length(relative_path) > 0),
  relative_path_key TEXT NOT NULL CHECK (typeof(relative_path_key) = 'text' AND length(relative_path_key) > 0),
  filesystem_file_name TEXT NOT NULL CHECK (typeof(filesystem_file_name) = 'text' AND length(filesystem_file_name) > 0),
  filesystem_extension TEXT NOT NULL CHECK (typeof(filesystem_extension) = 'text'),
  filesystem_size INTEGER NOT NULL CHECK (typeof(filesystem_size) = 'integer' AND filesystem_size >= 0),
  filesystem_mtime_ns INTEGER NOT NULL CHECK (typeof(filesystem_mtime_ns) = 'integer' AND filesystem_mtime_ns >= 0),
  filesystem_media_type TEXT NOT NULL CHECK (filesystem_media_type IN ('image', 'video')),
  source_media_id TEXT, metadata_ordinal INTEGER CHECK (metadata_ordinal IS NULL OR (typeof(metadata_ordinal) = 'integer' AND metadata_ordinal >= 0)),
  metadata_name TEXT, metadata_media_type TEXT,
  declared_size INTEGER CHECK (declared_size IS NULL OR (typeof(declared_size) = 'integer' AND declared_size >= 0)),
  remote_url TEXT, source_hash TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0))
);
CREATE UNIQUE INDEX uq_media_work_pair ON media(work_id, media_id);
CREATE UNIQUE INDEX uq_media_work_relative_path_key ON media(work_id, relative_path_key);

CREATE TABLE media_declarations (
  media_declaration_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0), source_media_id TEXT, declared_name TEXT,
  declared_media_type TEXT, declared_size INTEGER CHECK (declared_size IS NULL OR (typeof(declared_size) = 'integer' AND declared_size >= 0)),
  remote_url TEXT, source_hash TEXT, duration_ms INTEGER CHECK (duration_ms IS NULL OR (typeof(duration_ms) = 'integer' AND duration_ms >= 0)),
  match_state TEXT NOT NULL CHECK (match_state IN ('matched','unmatched','ambiguous','type_conflict')),
  matched_media_id INTEGER REFERENCES media(media_id) ON DELETE SET NULL,
  CHECK ((match_state = 'matched' AND matched_media_id IS NOT NULL) OR (match_state <> 'matched' AND matched_media_id IS NULL))
);
CREATE UNIQUE INDEX uq_media_declarations_ordinal ON media_declarations(work_id, ordinal);
CREATE UNIQUE INDEX uq_media_declarations_single_match ON media_declarations(matched_media_id) WHERE matched_media_id IS NOT NULL;
CREATE INDEX idx_media_declarations_match_state ON media_declarations(match_state, work_id);

CREATE TABLE tags (
  tag_id INTEGER PRIMARY KEY, display_value TEXT NOT NULL CHECK (typeof(display_value) = 'text' AND length(display_value) > 0),
  normalized_value TEXT, work_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(work_count) = 'integer' AND work_count >= 0)
);
CREATE UNIQUE INDEX uq_tags_display_value ON tags(display_value);
CREATE UNIQUE INDEX uq_tags_normalized_value ON tags(normalized_value) WHERE normalized_value IS NOT NULL;

CREATE TABLE work_tags (
  tag_id INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE RESTRICT, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0), sort_at_ms INTEGER NOT NULL CHECK (typeof(sort_at_ms) = 'integer'),
  PRIMARY KEY (tag_id, work_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX uq_work_tags_work_ordinal ON work_tags(work_id, ordinal);
CREATE INDEX idx_work_tags_tag_sort ON work_tags(tag_id, sort_at_ms DESC, work_id DESC);

CREATE TABLE social_relations (
  relation_id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('reply', 'retweet', 'quote', 'conversation', 'repost')),
  target_platform_id TEXT REFERENCES platforms(platform_id) ON DELETE RESTRICT,
  target_source_work_id TEXT NOT NULL CHECK (typeof(target_source_work_id) = 'text' AND length(target_source_work_id) > 0),
  target_work_id INTEGER REFERENCES works(work_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_social_relations_ordinal ON social_relations(work_id, ordinal);
CREATE UNIQUE INDEX uq_social_relations_target ON social_relations(work_id, relation_type, target_platform_id, target_source_work_id);
CREATE INDEX idx_social_relations_unresolved_target ON social_relations(target_platform_id, target_source_work_id) WHERE target_work_id IS NULL;

CREATE TABLE work_metrics (
  work_id INTEGER PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  likes INTEGER CHECK (likes IS NULL OR (typeof(likes) = 'integer' AND likes >= 0)),
  replies INTEGER CHECK (replies IS NULL OR (typeof(replies) = 'integer' AND replies >= 0)),
  comments INTEGER CHECK (comments IS NULL OR (typeof(comments) = 'integer' AND comments >= 0)),
  reposts INTEGER CHECK (reposts IS NULL OR (typeof(reposts) = 'integer' AND reposts >= 0)),
  views INTEGER CHECK (views IS NULL OR (typeof(views) = 'integer' AND views >= 0)),
  bookmarks INTEGER CHECK (bookmarks IS NULL OR (typeof(bookmarks) = 'integer' AND bookmarks >= 0))
);
`;

function configureCatalogConnection(db) {
  if (!db || typeof db.exec !== "function" || typeof db.pragma !== "function" || typeof db.defaultSafeIntegers !== "function") throw new TypeError("Catalog requires a better-sqlite3 Database connection");
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys = ON");
  const enabled = db.pragma("foreign_keys", { simple: true });
  if (enabled !== 1 && enabled !== 1n) throw new Error("Catalog requires SQLite foreign_keys=ON");
  return db;
}

function createCatalogSchema(db) {
  configureCatalogConnection(db);
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = { CATALOG_SCHEMA_VERSION, INDEX_NAMES, SCHEMA_SQL, TABLE_NAMES, configureCatalogConnection, createCatalogSchema };
