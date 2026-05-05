"use strict";

const { deepFreeze, compareText } = require("./contract.js");
const { validateMediaReconciliation } = require("./validation.js");
const { validateFilesystemMediaEligibility } = require("../index.js");

const RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION = 2;

class ReconciledMediaRelationalContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ReconciledMediaRelationalContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ReconciledMediaRelationalContractError(code, message, details);
}

function nullableText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail("invalid_metadata_declaration", `${field} must be text or null`);
  return value;
}

function safeInteger(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_metadata_declaration", `${field} must be a non-negative safe integer or null`);
  return value;
}

function metadataCategory(mediaType) {
  if (mediaType === "image" || mediaType === "animation_frame") return "image";
  if (mediaType === "video") return "video";
  return null;
}

function declarationFields(item, ordinal) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_metadata_declaration", `metadataDeclarations[${ordinal}] must be an object`);
  return {
    work_id: null,
    ordinal,
    source_media_id: nullableText(item.sourceId, `metadataDeclarations[${ordinal}].sourceId`),
    declared_name: nullableText(item.name, `metadataDeclarations[${ordinal}].name`),
    declared_media_type: nullableText(item.kind, `metadataDeclarations[${ordinal}].kind`),
    declared_size: safeInteger(item.size, `metadataDeclarations[${ordinal}].size`),
    remote_url: nullableText(item.url, `metadataDeclarations[${ordinal}].url`),
    source_hash: nullableText(item.hash, `metadataDeclarations[${ordinal}].hash`),
    duration_ms: safeInteger(item.durationMs, `metadataDeclarations[${ordinal}].durationMs`),
    match_state: "unmatched",
    matched_filesystem_relative_path_key: null,
  };
}

function filesystemFields(file, fileEligibility) {
  return {
    work_id: null,
    relative_path: file.relativePath,
    relative_path_key: file.relativePathKey,
    filesystem_file_name: file.fileName,
    filesystem_extension: file.extension,
    filesystem_size: file.size,
    filesystem_mtime_ns: file.mtimeNs,
    filesystem_media_type: fileEligibility.filesystemMediaType,
    source_media_id: null,
    metadata_ordinal: null,
    metadata_name: null,
    metadata_media_type: null,
    declared_size: null,
    remote_url: null,
    source_hash: null,
    duration_ms: null,
  };
}

function attachDeclaration(mediaRow, declaration) {
  mediaRow.source_media_id = declaration.source_media_id;
  mediaRow.metadata_ordinal = declaration.ordinal;
  mediaRow.metadata_name = declaration.declared_name;
  mediaRow.metadata_media_type = declaration.declared_media_type;
  mediaRow.declared_size = declaration.declared_size;
  mediaRow.remote_url = declaration.remote_url;
  mediaRow.source_hash = declaration.source_hash;
  mediaRow.duration_ms = declaration.duration_ms;
}

function deriveReconciledMediaCounts(rows) {
  if (!Array.isArray(rows)) fail("invalid_actual_media_rows", "actualMediaRows must be an array");
  let imageCount = 0;
  let videoCount = 0;
  for (const row of rows) {
    if (row.filesystem_media_type === "image") imageCount++;
    else if (row.filesystem_media_type === "video") videoCount++;
    else fail("invalid_actual_media_type", "Actual media requires an eligible filesystem media type");
  }
  return { imageCount, videoCount, mediaCount: rows.length };
}

function compareReconciledMediaRows(left, right) {
  return compareText(left.relative_path_key, right.relative_path_key);
}

function diagnosticCompare(left, right) {
  return compareText(left.code, right.code)
    || (left.metadataOrdinal ?? -1) - (right.metadataOrdinal ?? -1)
    || compareText(left.filesystemRelativePathKey || "", right.filesystemRelativePathKey || "")
    || compareText(left.referenceKind || "", right.referenceKind || "")
    || compareText(left.sourcePath || "", right.sourcePath || "");
}

function mapReconciledMediaToRelational({ metadataDeclarations, filesystemFiles, reconciliation, eligibility } = {}) {
  if (!Array.isArray(metadataDeclarations) || !Array.isArray(filesystemFiles)) fail("invalid_relational_input", "metadataDeclarations and filesystemFiles must be arrays");
  validateMediaReconciliation(reconciliation, { metadataDeclarations, filesystemFiles });
  validateFilesystemMediaEligibility(eligibility, { filesystemFiles });

  const declarations = metadataDeclarations.map(declarationFields);
  const declarationsByOrdinal = new Map(declarations.map(row => [row.ordinal, row]));
  const eligibilityByKey = new Map(eligibility.files.map(file => [file.relativePathKey, file]));
  const actualMediaRows = [];
  const actualByKey = new Map();
  const ignoredFilesystemFiles = [];
  const diagnostics = reconciliation.diagnostics.map(item => ({
    code: item.code,
    metadataOrdinal: item.metadataOrdinal ?? null,
    filesystemRelativePathKey: null,
    referenceKind: item.referenceKind ?? null,
    sourcePath: item.sourcePath ?? null,
  }));

  for (const file of filesystemFiles) {
    const fileEligibility = eligibilityByKey.get(file.relativePathKey);
    if (!fileEligibility.eligible) {
      ignoredFilesystemFiles.push({ relativePathKey: file.relativePathKey, eligibilityReason: fileEligibility.eligibilityReason });
      continue;
    }
    const row = filesystemFields(file, fileEligibility);
    actualMediaRows.push(row);
    actualByKey.set(file.relativePathKey, row);
  }

  const ambiguousOrdinals = new Set();
  for (const group of reconciliation.ambiguous) {
    for (const ordinal of group.metadataOrdinals) {
      ambiguousOrdinals.add(ordinal);
      declarationsByOrdinal.get(ordinal).match_state = "ambiguous";
    }
    diagnostics.push({ code: "ambiguous_media_enrichment", metadataOrdinal: group.metadataOrdinals[0] ?? null, filesystemRelativePathKey: null, referenceKind: null, sourcePath: null });
  }

  for (const match of reconciliation.matched) {
    const declaration = declarationsByOrdinal.get(match.metadataOrdinal);
    const actual = actualByKey.get(match.filesystemRelativePathKey);
    if (!actual) {
      diagnostics.push({ code: "matched_filesystem_file_ineligible", metadataOrdinal: match.metadataOrdinal, filesystemRelativePathKey: match.filesystemRelativePathKey, referenceKind: null, sourcePath: null });
      continue;
    }
    const metadataType = metadataCategory(declaration.declared_media_type);
    if (metadataType !== null && metadataType !== actual.filesystem_media_type) {
      declaration.match_state = "type_conflict";
      diagnostics.push({ code: "metadata_media_type_conflict", metadataOrdinal: match.metadataOrdinal, filesystemRelativePathKey: match.filesystemRelativePathKey, referenceKind: null, sourcePath: null });
      continue;
    }
    declaration.match_state = "matched";
    declaration.matched_filesystem_relative_path_key = match.filesystemRelativePathKey;
    attachDeclaration(actual, declaration);
  }

  for (const ordinal of reconciliation.metadataOnly) {
    if (!ambiguousOrdinals.has(ordinal)) declarationsByOrdinal.get(ordinal).match_state = "unmatched";
  }

  actualMediaRows.sort(compareReconciledMediaRows);
  declarations.sort((left, right) => left.ordinal - right.ordinal);
  ignoredFilesystemFiles.sort((left, right) => compareText(left.relativePathKey, right.relativePathKey));
  diagnostics.sort(diagnosticCompare);
  return deepFreeze({
    contractVersion: RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION,
    ok: true,
    error: null,
    actualMediaRows,
    declarationRows: declarations,
    mediaCounts: deriveReconciledMediaCounts(actualMediaRows),
    ignoredFilesystemFiles,
    diagnostics,
  });
}

module.exports = {
  RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION,
  ReconciledMediaRelationalContractError,
  compareReconciledMediaRows,
  deriveReconciledMediaCounts,
  mapReconciledMediaToRelational,
  mediaCounts: deriveReconciledMediaCounts,
  metadataCategory,
};
