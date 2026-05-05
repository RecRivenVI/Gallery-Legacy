"use strict";

const FILESYSTEM_AUTHORITY_CONTRACT_VERSION = 1;
const DISPLAY_SOURCES = Object.freeze(["metadata", "directory_parsed", "directory_raw"]);
const SORT_TIME_SOURCES = Object.freeze(["metadata_published", "directory_parsed", "directory_mtime"]);
const METADATA_STATES = Object.freeze(["valid", "partial", "missing", "malformed", "non_object", "unreadable", "unstable"]);
const ENRICHMENT_STATES = Object.freeze(["available", "partial", "unavailable"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

module.exports = {
  DISPLAY_SOURCES,
  ENRICHMENT_STATES,
  FILESYSTEM_AUTHORITY_CONTRACT_VERSION,
  METADATA_STATES,
  SORT_TIME_SOURCES,
  compareText,
  deepFreeze,
};
