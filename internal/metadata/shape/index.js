"use strict";

const { analyzeMetadataShape, METADATA_SHAPE_SIGNATURE_VERSION } = require("./engine.js");
const { SHAPE_POLICIES, shapePolicyForPlatform } = require("./policies/index.js");

function metadataShapeForPlatform(platformId, metadata) {
  const policy = shapePolicyForPlatform(platformId);
  if (!policy) throw new Error(`No metadata shape policy for platform: ${platformId}`);
  return analyzeMetadataShape(metadata, policy);
}

module.exports = {
  METADATA_SHAPE_SIGNATURE_VERSION,
  SHAPE_POLICIES,
  metadataShapeForPlatform,
  shapePolicyForPlatform,
};
