"use strict";

module.exports = Object.freeze({
  PLATFORM_ID: "微博",
  SHAPE_POLICY_VERSION: 1,
  // pic_infos keys are real per-media IDs, not stable schema field names.
  wildcardObjectPaths: Object.freeze(["$.pic_infos"]),
  excludedPaths: Object.freeze([]),
});
