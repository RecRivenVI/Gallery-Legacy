"use strict";

const {
  AUTHOR_AUTHORITY_STATES,
  AUTHOR_PREPARATION_STATES,
  SNAPSHOT_PREPARATION_CONTRACT_VERSION,
  SnapshotPreparationContractError,
  WORK_FAILURE_STAGES,
} = require("./preparation-contract.js");
const {
  createStreamingAuthorPreparation,
  mapPreparedEntry,
  prepareMetadataEntry,
  prepareAuthorObservation,
  preparePlatformSnapshot,
} = require("./prepare.js");
const { createPreparationPool } = require("./preparation-pool.js");
const { validatePlatformObservation } = require("./preparation-validation.js");

module.exports = {
  AUTHOR_AUTHORITY_STATES,
  AUTHOR_PREPARATION_STATES,
  SNAPSHOT_PREPARATION_CONTRACT_VERSION,
  SnapshotPreparationContractError,
  WORK_FAILURE_STAGES,
  createStreamingAuthorPreparation,
  createPreparationPool,
  mapPreparedEntry,
  prepareMetadataEntry,
  prepareAuthorObservation,
  preparePlatformSnapshot,
  validatePlatformObservation,
};
