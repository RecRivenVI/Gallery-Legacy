"use strict";

const {
  EVIDENCE_RANK,
  MATCH_EVIDENCE_CODES,
  MEDIA_RECONCILIATION_CONTRACT_VERSION,
  compareText,
  fail,
} = require("./contract.js");
const { canonicalFilesystemFiles } = require("./inputs.js");

function increment(map, value, code) {
  if (!map.has(value)) fail(code, `Unknown reconciliation identity: ${value}`);
  map.set(value, map.get(value) + 1);
}

function validateEvidence(values) {
  if (!Array.isArray(values) || values.length === 0) fail("invalid_reconciliation_result", "Candidate evidence must be a non-empty array");
  let previous = null;
  for (const value of values) {
    if (!value || !MATCH_EVIDENCE_CODES.includes(value.code) || !["relative_path", "file_name"].includes(value.referenceKind)
      || typeof value.sourcePath !== "string" || !value.sourcePath) fail("invalid_reconciliation_result", "Candidate evidence is invalid");
    const key = `${EVIDENCE_RANK[value.code]}\0${value.sourcePath}\0${value.referenceKind}`;
    if (previous !== null && compareText(previous, key) >= 0) fail("invalid_reconciliation_order", "Candidate evidence order is unstable or duplicated");
    previous = key;
  }
}

function validateMediaReconciliation(result, { metadataDeclarations, filesystemFiles } = {}) {
  if (!result || typeof result !== "object" || result.contractVersion !== MEDIA_RECONCILIATION_CONTRACT_VERSION) fail("invalid_reconciliation_result", "Reconciliation contract version mismatch");
  if (!Array.isArray(metadataDeclarations)) fail("invalid_metadata_input", "metadataDeclarations must be an array");
  const files = canonicalFilesystemFiles(filesystemFiles);
  const metadataCounts = new Map(metadataDeclarations.map((_, ordinal) => [ordinal, 0]));
  const filesystemCounts = new Map(files.map(file => [file.relativePathKey, 0]));
  const matchedPairs = new Set();

  for (const field of ["matched", "metadataOnly", "filesystemOnly", "ambiguous", "diagnostics"]) {
    if (!Array.isArray(result[field])) fail("invalid_reconciliation_result", `${field} must be an array`);
  }
  for (const match of result.matched) {
    increment(metadataCounts, match.metadataOrdinal, "invalid_reconciliation_result");
    increment(filesystemCounts, match.filesystemRelativePathKey, "invalid_reconciliation_result");
    validateEvidence(match.evidence);
    const key = `${match.metadataOrdinal}\0${match.filesystemRelativePathKey}`;
    if (matchedPairs.has(key)) fail("invalid_reconciliation_result", "Duplicate matched pair");
    matchedPairs.add(key);
  }
  for (const metadataOrdinal of result.metadataOnly) increment(metadataCounts, metadataOrdinal, "invalid_reconciliation_result");
  for (const fileKey of result.filesystemOnly) increment(filesystemCounts, fileKey, "invalid_reconciliation_result");
  for (const group of result.ambiguous) {
    if (!Array.isArray(group.metadataOrdinals) || !Array.isArray(group.filesystemRelativePathKeys) || !Array.isArray(group.candidates)
      || group.metadataOrdinals.length === 0 || group.filesystemRelativePathKeys.length === 0) fail("invalid_reconciliation_result", "Ambiguous group is incomplete");
    group.metadataOrdinals.forEach(value => increment(metadataCounts, value, "invalid_reconciliation_result"));
    group.filesystemRelativePathKeys.forEach(value => increment(filesystemCounts, value, "invalid_reconciliation_result"));
    if (group.metadataOrdinals.some((value, index) => index > 0 && group.metadataOrdinals[index - 1] >= value)
      || group.filesystemRelativePathKeys.some((value, index) => index > 0 && compareText(group.filesystemRelativePathKeys[index - 1], value) >= 0)) fail("invalid_reconciliation_order", "Ambiguous member order is unstable");
    if (!Array.isArray(group.diagnostics) || group.diagnostics.length !== 1
      || !["conflicting_file_references", "non_unique_candidate_graph"].includes(group.diagnostics[0]?.code)) fail("invalid_reconciliation_result", "Ambiguous diagnostic is invalid");
    let previousCandidate = null;
    for (const candidate of group.candidates) {
      if (!group.metadataOrdinals.includes(candidate.metadataOrdinal) || !group.filesystemRelativePathKeys.includes(candidate.filesystemRelativePathKey)) fail("invalid_reconciliation_result", "Ambiguous candidate escapes its component");
      validateEvidence(candidate.evidence);
      const key = `${String(candidate.metadataOrdinal).padStart(12, "0")}\0${candidate.filesystemRelativePathKey}`;
      if (previousCandidate !== null && compareText(previousCandidate, key) >= 0) fail("invalid_reconciliation_order", "Ambiguous candidate order is unstable");
      previousCandidate = key;
    }
  }
  for (const [ordinal, count] of metadataCounts) if (count !== 1) fail("partition_invariant_failed", `metadataOrdinal ${ordinal} appears ${count} times`);
  for (const [key, count] of filesystemCounts) if (count !== 1) fail("partition_invariant_failed", `filesystemRelativePathKey ${key} appears ${count} times`);

  const matchedOrder = result.matched.map(value => `${String(value.metadataOrdinal).padStart(12, "0")}\0${value.filesystemRelativePathKey}`);
  const metadataOnlyOrder = result.metadataOnly.slice().sort((left, right) => left - right);
  const filesystemOnlyOrder = result.filesystemOnly.slice().sort(compareText);
  if (matchedOrder.some((value, index) => index > 0 && compareText(matchedOrder[index - 1], value) > 0)
    || metadataOnlyOrder.some((value, index) => value !== result.metadataOnly[index])
    || filesystemOnlyOrder.some((value, index) => value !== result.filesystemOnly[index])) fail("invalid_reconciliation_order", "Reconciliation partition ordering is unstable");
  let previousGroup = null;
  for (const group of result.ambiguous) {
    const key = `${String(group.metadataOrdinals[0]).padStart(12, "0")}\0${group.filesystemRelativePathKeys[0]}`;
    if (previousGroup !== null && compareText(previousGroup, key) > 0) fail("invalid_reconciliation_order", "Ambiguous group order is unstable");
    previousGroup = key;
  }
  let previousDiagnostic = null;
  for (const item of result.diagnostics) {
    if (!item || typeof item.code !== "string") fail("invalid_reconciliation_result", "Reconciliation diagnostic is invalid");
    const key = `${String(item.metadataOrdinal ?? -1).padStart(12, "0")}\0${item.code}\0${item.referenceKind || ""}\0${item.sourcePath || ""}`;
    if (previousDiagnostic !== null && compareText(previousDiagnostic, key) >= 0) fail("invalid_reconciliation_order", "Diagnostic order is unstable or duplicated");
    previousDiagnostic = key;
  }
  return true;
}

module.exports = { validateMediaReconciliation };
