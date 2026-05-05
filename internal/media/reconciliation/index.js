"use strict";

const {
  FILE_REFERENCE_KINDS,
  MATCH_EVIDENCE_CODES,
  MEDIA_RECONCILIATION_CONTRACT_VERSION,
  MediaReconciliationContractError,
} = require("./contract.js");
const { reconcileMedia } = require("./reconcile.js");
const {
  RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION,
  ReconciledMediaRelationalContractError,
  compareReconciledMediaRows,
  deriveReconciledMediaCounts,
  mapReconciledMediaToRelational,
  mediaCounts,
  metadataCategory,
} = require("./relational.js");
const { validateMediaReconciliation } = require("./validation.js");

module.exports = {
  FILE_REFERENCE_KINDS,
  MATCH_EVIDENCE_CODES,
  MEDIA_RECONCILIATION_CONTRACT_VERSION,
  MediaReconciliationContractError,
  RECONCILED_MEDIA_RELATIONAL_CONTRACT_VERSION,
  ReconciledMediaRelationalContractError,
  compareReconciledMediaRows,
  deriveReconciledMediaCounts,
  mapReconciledMediaToRelational,
  mediaCounts,
  metadataCategory,
  reconcileMedia,
  validateMediaReconciliation,
};
