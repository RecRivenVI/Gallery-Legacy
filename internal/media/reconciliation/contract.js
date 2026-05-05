"use strict";

const MEDIA_RECONCILIATION_CONTRACT_VERSION = 2;
const FILE_REFERENCE_KINDS = Object.freeze(["relative_path", "file_name"]);
const MATCH_EVIDENCE_CODES = Object.freeze(["exact_relative_path", "exact_file_name"]);
const EVIDENCE_RANK = Object.freeze({ exact_relative_path: 0, exact_file_name: 1 });

class MediaReconciliationContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "MediaReconciliationContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new MediaReconciliationContractError(code, message, details);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceCompare(left, right) {
  return EVIDENCE_RANK[left.code] - EVIDENCE_RANK[right.code]
    || compareText(left.sourcePath, right.sourcePath)
    || compareText(left.referenceKind, right.referenceKind);
}

function sortEvidence(values) {
  const unique = new Map();
  for (const value of values) unique.set(`${value.code}\0${value.sourcePath}\0${value.referenceKind}`, value);
  return [...unique.values()].sort(evidenceCompare);
}

function diagnosticCompare(left, right) {
  return (left.metadataOrdinal ?? -1) - (right.metadataOrdinal ?? -1)
    || compareText(left.code, right.code)
    || compareText(left.referenceKind || "", right.referenceKind || "")
    || compareText(left.sourcePath || "", right.sourcePath || "");
}

function sortDiagnostics(values) {
  const unique = new Map();
  for (const value of values) unique.set(`${value.metadataOrdinal ?? ""}\0${value.code}\0${value.referenceKind || ""}\0${value.sourcePath || ""}`, value);
  return [...unique.values()].sort(diagnosticCompare);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

module.exports = {
  EVIDENCE_RANK,
  FILE_REFERENCE_KINDS,
  MATCH_EVIDENCE_CODES,
  MEDIA_RECONCILIATION_CONTRACT_VERSION,
  MediaReconciliationContractError,
  compareText,
  deepFreeze,
  fail,
  sortDiagnostics,
  sortEvidence,
};
