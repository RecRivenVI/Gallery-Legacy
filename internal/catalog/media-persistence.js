"use strict";

const { deepFreeze } = require("../media/reconciliation/contract.js");
const {
  RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION,
  compareReconciledMediaRows,
  deriveReconciledMediaCounts,
} = require("../media/reconciliation/relational.js");
const { normalizeRelativePath } = require("../library/paths.js");
const { CATALOG_SCHEMA_VERSION } = require("./schema.js");
const { stableJson } = require("./stable-json.js");

const RECONCILED_MEDIA_PERSISTENCE_CONTRACT_VERSION = 2;
const SQLITE_INT64_MAX = 9223372036854775807n;

class ReconciledMediaPersistenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ReconciledMediaPersistenceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ReconciledMediaPersistenceError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  return value;
}

function assertMtimeNs(value, field) {
  if (typeof value !== "bigint" || value < 0n || value > SQLITE_INT64_MAX) fail("invalid_mtime_ns", `${field} must be a non-negative signed int64 BigInt`);
}

function assertActualMediaRows(rows) {
  if (!Array.isArray(rows)) fail("invalid_actual_media_rows", "actualMediaRows must be an array");
  const paths = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isPlainObject(row) || row.work_id !== null) fail("invalid_actual_media_row", `actualMediaRows[${index}] is invalid`);
    const normalized = normalizeRelativePath(row.relative_path);
    if (normalized.relativePath !== row.relative_path || normalized.relativePathKey !== row.relative_path_key) fail("invalid_actual_media_row", `actualMediaRows[${index}] path identity is not canonical`);
    if (paths.has(row.relative_path_key)) fail("duplicate_filesystem_relative_path_key", "Actual media snapshot contains duplicate physical paths");
    paths.add(row.relative_path_key);
    if (typeof row.filesystem_file_name !== "string" || typeof row.filesystem_extension !== "string") fail("invalid_actual_media_row", `actualMediaRows[${index}] file facts are incomplete`);
    if (!Number.isSafeInteger(row.filesystem_size) || row.filesystem_size < 0) fail("invalid_actual_media_row", `actualMediaRows[${index}] size is unsafe`);
    assertMtimeNs(row.filesystem_mtime_ns, `actualMediaRows[${index}].filesystem_mtime_ns`);
    if (!['image', 'video'].includes(row.filesystem_media_type)) fail("invalid_actual_media_row", `actualMediaRows[${index}] media type is invalid`);
  }
  return rows;
}

function assertDeclarationRows(rows) {
  if (!Array.isArray(rows)) fail("invalid_media_declarations", "declarationRows must be an array");
  const ordinals = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!isPlainObject(row) || row.work_id !== null || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0) fail("invalid_media_declaration", `declarationRows[${index}] is invalid`);
    if (ordinals.has(row.ordinal)) fail("duplicate_metadata_ordinal", "Metadata declaration snapshot contains duplicate ordinals");
    ordinals.add(row.ordinal);
    if (!["matched", "unmatched", "ambiguous", "type_conflict"].includes(row.match_state)) fail("invalid_media_declaration", `declarationRows[${index}] match state is invalid`);
    if (row.match_state === "matched" && typeof row.matched_filesystem_relative_path_key !== "string") fail("invalid_media_declaration", `declarationRows[${index}] matched path is missing`);
    if (row.match_state !== "matched" && row.matched_filesystem_relative_path_key !== null) fail("invalid_media_declaration", `declarationRows[${index}] invents a match`);
  }
  return rows;
}

function staticDeclaration(row) {
  return {
    ordinal: row.ordinal,
    source_media_id: row.source_media_id,
    declared_name: row.declared_name,
    declared_media_type: row.declared_media_type,
    declared_size: row.declared_size,
    remote_url: row.remote_url,
    source_hash: row.source_hash,
    duration_ms: row.duration_ms,
  };
}

function assertMappedCandidate(candidate) {
  if (!isPlainObject(candidate) || candidate.ok !== true || candidate.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION
    || !isPlainObject(candidate.rows) || !isPlainObject(candidate.rows.work) || !Array.isArray(candidate.rows.mediaDeclarations)) {
    fail("invalid_mapped_candidate", "Persistence binding requires a successful Schema v4 mapped candidate");
  }
  const platformId = candidate.rows.work.platform_id;
  const workRelativePathKey = candidate.rows.work.relative_path_key;
  if (!candidate.identities?.work || candidate.identities.work.platform_id !== platformId || candidate.identities.work.relative_path_key !== workRelativePathKey) {
    fail("invalid_mapped_candidate", "Mapped physical work identity mismatch");
  }
  return { platformId, workRelativePathKey };
}

function assertRelational(result, mapped) {
  if (!isPlainObject(result) || result.contractVersion !== RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION || result.ok !== true
    || !Array.isArray(result.actualMediaRows) || !Array.isArray(result.declarationRows)) fail("reconciled_media_result_not_successful", "Persistence binding requires a successful relational result");
  assertActualMediaRows(result.actualMediaRows);
  assertDeclarationRows(result.declarationRows);
  const derived = deriveReconciledMediaCounts(result.actualMediaRows);
  if (stableJson(derived) !== stableJson(result.mediaCounts)) fail("reconciled_media_count_mismatch", "Actual media counts differ from filesystem rows");
  const expected = mapped.rows.mediaDeclarations.map(staticDeclaration);
  const actual = result.declarationRows.map(staticDeclaration);
  if (stableJson(expected) !== stableJson(actual)) fail("reconciled_media_metadata_mismatch", "Relational declarations differ from Adapter declarations");
  return result;
}

function validateReconciledMediaPersistence(candidate) {
  const identity = assertMappedCandidate(candidate);
  const authority = candidate.mediaPersistence;
  if (!authority) return null;
  if (authority.contractVersion !== RECONCILED_MEDIA_PERSISTENCE_CONTRACT_VERSION
    || authority.platformId !== identity.platformId || authority.workRelativePathKey !== identity.workRelativePathKey) {
    fail("reconciled_media_work_identity_mismatch", "Media persistence authority belongs to another physical work");
  }
  if (!['complete', 'incomplete'].includes(authority.filesystemFilesState)) fail("invalid_reconciled_media_persistence", "filesystemFilesState is invalid");
  assertActualMediaRows(authority.actualMediaRows);
  assertDeclarationRows(authority.declarationRows);
  if (stableJson(deriveReconciledMediaCounts(authority.actualMediaRows)) !== stableJson(authority.mediaCounts)) fail("reconciled_media_count_mismatch", "Authorized counts differ from actual media rows");
  return authority;
}

function bindReconciledMediaPersistence(mappedCandidate, relationalResult, options = {}) {
  if (isPlainObject(mappedCandidate) && Object.hasOwn(mappedCandidate, "mediaPersistence")) fail("invalid_reconciled_media_persistence", "Mapped candidate already carries persistence authority");
  const identity = assertMappedCandidate(mappedCandidate);
  const relational = assertRelational(relationalResult, mappedCandidate);
  const actualMediaRows = relational.actualMediaRows.map(cloneValue).sort(compareReconciledMediaRows);
  const declarationRows = relational.declarationRows.map(cloneValue).sort((left, right) => left.ordinal - right.ordinal);
  const mediaPersistence = {
    contractVersion: RECONCILED_MEDIA_PERSISTENCE_CONTRACT_VERSION,
    platformId: identity.platformId,
    workRelativePathKey: identity.workRelativePathKey,
    filesystemFilesState: options.filesystemFilesState === "complete" ? "complete" : "incomplete",
    actualMediaRows,
    declarationRows,
    mediaCounts: deriveReconciledMediaCounts(actualMediaRows),
  };
  const candidate = { ...cloneValue(mappedCandidate), mediaPersistence };
  validateReconciledMediaPersistence(candidate);
  return deepFreeze(candidate);
}

module.exports = {
  RECONCILED_MEDIA_PERSISTENCE_CONTRACT_VERSION,
  ReconciledMediaPersistenceError,
  bindReconciledMediaPersistence,
  compareReconciledMediaRows,
  deriveReconciledMediaCounts,
  validateReconciledMediaPersistence,
};
