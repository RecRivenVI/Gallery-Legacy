"use strict";

const FILESYSTEM_OBSERVATION_CONTRACT_VERSION = 2;
const PRESENCE_STATES = Object.freeze(["present", "missing", "unreadable", "unstable"]);
const COLLECTION_STATES = Object.freeze(["complete", "incomplete"]);
const MTIME_AUTHORITY_LIMITATION = "Content changes that preserve filesystem mtime are intentionally not observable; the observer does not compute a fallback content hash.";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) => compareText(left.path, right.path)
    || compareText(left.operation, right.operation)
    || compareText(left.code, right.code)
    || compareText(left.osCode || "", right.osCode || ""));
}

function diagnostic(code, path, operation, osCode = null) {
  return { code, path, operation, osCode };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

module.exports = {
  COLLECTION_STATES,
  FILESYSTEM_OBSERVATION_CONTRACT_VERSION,
  MTIME_AUTHORITY_LIMITATION,
  PRESENCE_STATES,
  compareText,
  deepFreeze,
  diagnostic,
  sortDiagnostics,
};
