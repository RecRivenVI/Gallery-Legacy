"use strict";

const SNAPSHOT_PREPARATION_CONTRACT_VERSION = 2;
const WORK_FAILURE_STAGES = Object.freeze([
  "observation",
  "mapping",
  "media_persistence_binding",
]);
const AUTHOR_PREPARATION_STATES = Object.freeze(["complete", "incomplete"]);
const AUTHOR_AUTHORITY_STATES = Object.freeze([
  "authoritative",
  "none",
  "latest_invalid",
]);

class SnapshotPreparationContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "SnapshotPreparationContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new SnapshotPreparationContractError(code, message, details);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function comparePreparedCandidates(left, right) {
  return (
    compareText(left.rows.work.platform_id, right.rows.work.platform_id) ||
    compareText(
      left.rows.work.relative_path_key,
      right.rows.work.relative_path_key,
    )
  );
}

function compareWorkFailures(left, right) {
  return (
    compareText(left.authorDirectoryName, right.authorDirectoryName) ||
    compareText(left.workDirectoryName, right.workDirectoryName) ||
    compareText(left.stage, right.stage) ||
    compareText(left.code, right.code)
  );
}

function compareAuthorOutcomes(left, right) {
  return compareText(left.authorRelativePathKey, right.authorRelativePathKey);
}

module.exports = {
  AUTHOR_AUTHORITY_STATES,
  AUTHOR_PREPARATION_STATES,
  SNAPSHOT_PREPARATION_CONTRACT_VERSION,
  SnapshotPreparationContractError,
  WORK_FAILURE_STAGES,
  compareAuthorOutcomes,
  comparePreparedCandidates,
  compareText,
  compareWorkFailures,
  deepFreeze,
  fail,
};
