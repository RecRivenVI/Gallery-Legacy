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
  prepareAuthorObservation,
  preparePlatformSnapshot,
} = require("./prepare.js");
const { validatePlatformObservation } = require("./preparation-validation.js");

module.exports = {
  AUTHOR_AUTHORITY_STATES,
  AUTHOR_PREPARATION_STATES,
  SNAPSHOT_PREPARATION_CONTRACT_VERSION,
  SnapshotPreparationContractError,
  WORK_FAILURE_STAGES,
  createStreamingAuthorPreparation,
  prepareAuthorObservation,
  preparePlatformSnapshot,
  validatePlatformObservation,
};
