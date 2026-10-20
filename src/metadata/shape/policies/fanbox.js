"use strict";

module.exports = Object.freeze({
  PLATFORM_ID: "pixivFANBOX",
  SHAPE_POLICY_VERSION: 1,
  // Real article fixtures use opaque image IDs as imageMap object keys.
  wildcardObjectPaths: Object.freeze(["$.articleBody.imageMap"]),
  excludedPaths: Object.freeze([]),
});
