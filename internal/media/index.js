"use strict";

const {
  FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION,
  FILESYSTEM_MEDIA_TYPES,
  FilesystemMediaEligibilityContractError,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
} = require("./eligibility-contract.js");
const { evaluateFilesystemMediaEligibility, validateFilesystemMediaEligibility } = require("./eligibility.js");

module.exports = {
  FILESYSTEM_MEDIA_ELIGIBILITY_CONTRACT_VERSION,
  FILESYSTEM_MEDIA_TYPES,
  FilesystemMediaEligibilityContractError,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  evaluateFilesystemMediaEligibility,
  validateFilesystemMediaEligibility,
};
