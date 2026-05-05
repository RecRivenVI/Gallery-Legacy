"use strict";

const { normalizeRelativePath } = require("../library/paths.js");
const { parsePlatformDirectoryIdentity } = require("../library/directory-parsers.js");
const { asId, directoryTimestampMs, fallback, firstSelection, invalid, isObject, warning } = require("./helpers.js");

// Public normalized result structure/semantics. This is independent from each
// platform Adapter.VERSION, which versions that platform's extraction behavior.
const ADAPTER_CONTRACT_VERSION = 2;
const TEXT_FORMATS = Object.freeze(["plain", "html", "markdown"]);
const STRUCTURED_ENCODINGS = Object.freeze(["json_text", "opaque_text"]);

function diagnostics() {
  return { warnings: [], invalidFields: [], fallbacksUsed: [] };
}

function createResult(platformId, adapterVersion, context = {}) {
  return {
    contractVersion: ADAPTER_CONTRACT_VERSION,
    platformId,
    adapterVersion,
    valid: true,
    invalidReason: null,
    sourceContext: {
      authorDirectoryName: context.authorDirectoryName || null,
      workDirectoryName: context.workDirectoryName || null,
      metadataRelativePath: context.metadataRelativePath || null,
      directoryTimestampMs: Number.isSafeInteger(context.directoryTimestampMs) ? context.directoryTimestampMs : directoryTimestampMs(context.workDirectoryName),
    },
    work: {
      sourceWorkId: null,
      title: null,
      publishedAtMs: null,
      updatedAtMs: null,
      language: null,
      access: { currentUserCanView: null, minimumCentsPledgedToView: null },
      flags: { adult: null, aiGenerated: null, paid: null, restricted: null, sensitive: null, hasFull: null, advertisement: null },
    },
    authorProfile: {
      sourceAuthorId: null,
      displayName: null,
      handle: null,
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      profileUrl: null,
      location: null,
      language: null,
      verified: null,
      verificationType: null,
      verificationReason: null,
      followersCount: null,
      followingCount: null,
      statusesCount: null,
      profileLinks: [],
    },
    tags: [],
    mediaDeclarations: [],
    richText: { primary: null, supplementary: [] },
    structuredSources: [],
    relations: [],
    metrics: { likes: null, replies: null, comments: null, reposts: null, views: null, bookmarks: null },
    fieldSources: [],
    diagnostics: diagnostics(),
  };
}

function metadataPath(path) {
  return path.startsWith("$") ? path : `$.${path}`;
}

function fileReference(kind, value, sourcePath, diagnostics) {
  if (!["relative_path", "file_name"].includes(kind)) throw new TypeError(`Unsupported file reference kind: ${kind}`);
  if (typeof sourcePath !== "string" || !sourcePath) throw new TypeError("File reference sourcePath is required");
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    invalid(diagnostics, sourcePath, kind === "file_name" ? "local file basename" : "work-relative file path", value);
    warning(diagnostics, "invalid_file_reference", sourcePath);
    return null;
  }
  if (/[\\/]$/.test(value) || (kind === "file_name" && /[\\/]/.test(value))) {
    invalid(diagnostics, sourcePath, kind === "file_name" ? "local file basename" : "work-relative file path", value);
    warning(diagnostics, "invalid_file_reference", sourcePath);
    return null;
  }
  let normalized;
  try { normalized = normalizeRelativePath(value); }
  catch {
    invalid(diagnostics, sourcePath, kind === "file_name" ? "local file basename" : "work-relative file path", value);
    warning(diagnostics, "invalid_file_reference", sourcePath);
    return null;
  }
  if (kind === "file_name" && normalized.relativePath.includes("\\")) throw new Error("File reference basename normalization produced a path");
  return { kind, value: normalized.relativePath, sourcePath: metadataPath(sourcePath) };
}

function addFieldSource(result, field, sourceKind, sourcePath, priority = 1) {
  if (!result || !Array.isArray(result.fieldSources)) throw new TypeError("Adapter result does not support fieldSources");
  if (!field || !["filesystem", "metadata"].includes(sourceKind) || !sourcePath || !Number.isInteger(priority) || priority < 1) {
    throw new TypeError("Invalid field source evidence");
  }
  result.fieldSources.push({
    field,
    sourceKind,
    sourcePath: sourceKind === "metadata" ? metadataPath(sourcePath) : sourcePath,
    priority,
  });
}

function selectField(result, field, candidates, decoder) {
  const selection = firstSelection(candidates, decoder, result.diagnostics);
  if (!selection) return null;
  const sourceKind = selection.candidate.sourceKind || "metadata";
  const priority = selection.candidate.priority || selection.index + 1;
  addFieldSource(result, field, sourceKind, selection.candidate.sourcePath || selection.candidate.path, priority);
  if (selection.index > 0) fallback(result.diagnostics, field, selection.candidate.path);
  return selection.value;
}

function selectIdentity(result, field, candidates) {
  // Decode every raw identity candidate so an unsafe lower-priority Number is
  // still diagnosed even when the filesystem identity wins.
  const decoded = candidates.map((candidate, index) => ({
    ...candidate,
    index,
    decoded: asId(candidate.value, result.diagnostics, candidate.path),
  }));
  const selection = decoded.find(candidate => candidate.decoded !== null);
  if (!selection) {
    warning(result.diagnostics, "missing_identity", field);
    return null;
  }
  const sourceKind = selection.sourceKind || "metadata";
  const priority = selection.priority || selection.index + 1;
  addFieldSource(result, field, sourceKind, selection.sourcePath || selection.path, priority);
  if (selection.index > 0) fallback(result.diagnostics, field, selection.path);
  return selection.decoded;
}

function beginAdapt(adapter, context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new TypeError("Adapter context must be an object");
  if (context.platformId !== adapter.PLATFORM_ID) throw new Error(`Adapter platform mismatch: ${context.platformId || "(missing)"} != ${adapter.PLATFORM_ID}`);
  const result = createResult(adapter.PLATFORM_ID, adapter.VERSION, context);
  const directory = parsePlatformDirectoryIdentity(adapter.PLATFORM_ID, context.authorDirectoryName, context.workDirectoryName);
  const metadata = context.metadata;
  if (!isObject(metadata)) {
    result.work.sourceWorkId = selectIdentity(result, "work.sourceWorkId", [
      { path: "workDirectoryName.timestampedSuffix", sourceKind: "filesystem", value: directory.work.sourceWorkId },
    ]);
    result.authorProfile.sourceAuthorId = selectIdentity(result, "authorProfile.sourceAuthorId", [
      { path: "authorDirectoryName", sourceKind: "filesystem", value: directory.author.sourceAuthorId },
    ]);
    result.valid = false;
    result.invalidReason = "metadata_not_object";
    result.diagnostics.invalidFields.push({ path: "metadata", expected: "object", actual: Array.isArray(metadata) ? "array" : metadata === null ? "null" : typeof metadata });
    warning(result.diagnostics, "metadata_not_object", "metadata");
    return { result, metadata: null };
  }
  return { result, metadata };
}

function setIdentities(result, context, workCandidates, authorCandidates) {
  const directory = parsePlatformDirectoryIdentity(result.platformId, context.authorDirectoryName, context.workDirectoryName);
  result.work.sourceWorkId = selectIdentity(result, "work.sourceWorkId", [
    ...workCandidates,
    { path: "workDirectoryName.timestampedSuffix", sourceKind: "filesystem", value: directory.work.sourceWorkId },
  ]);
  result.authorProfile.sourceAuthorId = selectIdentity(result, "authorProfile.sourceAuthorId", [
    ...authorCandidates,
    { path: "authorDirectoryName", sourceKind: "filesystem", value: directory.author.sourceAuthorId },
  ]);
}

function richText(sourcePath, sourceFormat, sourceText, role = "body") {
  if (!TEXT_FORMATS.includes(sourceFormat)) throw new Error(`Unsupported source format: ${sourceFormat}`);
  if (typeof sourceText !== "string") throw new TypeError("Rich text source must be a string");
  return { role, sourcePath, sourceFormat, sourceText };
}

function setPrimaryRichText(result, value, priority = 1) {
  if (!value) return;
  result.richText.primary = value;
  addFieldSource(result, "richText.primary", "metadata", value.sourcePath, priority);
}

function structuredSource(sourcePath, encoding, sourceText, role = "body_source", schemaHint = null) {
  if (!STRUCTURED_ENCODINGS.includes(encoding)) throw new Error(`Unsupported structured encoding: ${encoding}`);
  if (typeof sourceText !== "string") throw new TypeError("Structured source must be a string");
  if (schemaHint !== null && typeof schemaHint !== "string") throw new TypeError("Structured source schemaHint must be a string or null");
  return { role, sourcePath, encoding, sourceText, schemaHint };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stabilizeEvidence(result) {
  result.fieldSources.sort((left, right) => compareText(left.field, right.field)
    || left.priority - right.priority
    || compareText(left.sourceKind, right.sourceKind)
    || compareText(left.sourcePath, right.sourcePath));
}

function stabilizeMediaDeclarations(result) {
  for (const item of result.mediaDeclarations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Normalized media declaration must be an object");
    const references = item.fileReferences === undefined ? [] : item.fileReferences;
    if (!Array.isArray(references)) throw new TypeError("Normalized media fileReferences must be an array");
    const unique = new Map();
    for (const reference of references) {
      if (!reference || !["relative_path", "file_name"].includes(reference.kind)
        || typeof reference.value !== "string" || !reference.value
        || typeof reference.sourcePath !== "string" || !reference.sourcePath) throw new TypeError("Invalid normalized media file reference");
      unique.set(`${reference.kind}\0${reference.value}\0${reference.sourcePath}`, reference);
    }
    item.fileReferences = [...unique.values()].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "relative_path" ? -1 : 1)
      || compareText(left.value, right.value) || compareText(left.sourcePath, right.sourcePath));
  }
}

function finalize(result) {
  // Source identities are optional enrichment. Physical author/work identity is
  // always the canonical filesystem relative-path key and is not synthesized
  // from an unparsed raw directory name.
  stabilizeMediaDeclarations(result);
  stabilizeEvidence(result);
  return result;
}

function invalidJsonResult(adapter, context, error) {
  const result = createResult(adapter.PLATFORM_ID, adapter.VERSION, context);
  const directory = parsePlatformDirectoryIdentity(adapter.PLATFORM_ID, context?.authorDirectoryName, context?.workDirectoryName);
  result.work.sourceWorkId = selectIdentity(result, "work.sourceWorkId", [
    { path: "workDirectoryName.timestampedSuffix", sourceKind: "filesystem", value: directory.work.sourceWorkId },
  ]);
  result.authorProfile.sourceAuthorId = selectIdentity(result, "authorProfile.sourceAuthorId", [
    { path: "authorDirectoryName", sourceKind: "filesystem", value: directory.author.sourceAuthorId },
  ]);
  result.valid = false;
  result.invalidReason = "malformed_json";
  warning(result.diagnostics, "malformed_json", "metadata", String(error && error.message || error));
  stabilizeEvidence(result);
  return result;
}

function adaptJsonWithMetadata(adapter, source, context) {
  if (typeof source !== "string") throw new TypeError("Metadata JSON source must be a string");
  let metadata;
  try { metadata = JSON.parse(source); }
  catch (error) { return { metadata: null, result: invalidJsonResult(adapter, context, error) }; }
  return { metadata, result: adapter.adapt({ ...context, metadata }) };
}

function adaptJson(adapter, source, context) {
  return adaptJsonWithMetadata(adapter, source, context).result;
}

module.exports = {
  ADAPTER_CONTRACT_VERSION,
  STRUCTURED_ENCODINGS,
  TEXT_FORMATS,
  addFieldSource,
  adaptJson,
  adaptJsonWithMetadata,
  beginAdapt,
  createResult,
  fileReference,
  finalize,
  richText,
  selectField,
  setPrimaryRichText,
  setIdentities,
  structuredSource,
};
