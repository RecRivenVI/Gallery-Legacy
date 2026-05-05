"use strict";
const path = require("node:path");
const os = require("node:os");
const { PLATFORM_REGISTRY } = require("../../internal/library/platforms.js");
// Mapping-only fixtures: paths are synthetic and never accessed by unit tests.
function sources(root = path.join(os.tmpdir(), "gallery-synthetic-roots")) {
  return Object.fromEntries(PLATFORM_REGISTRY.map(p => [p.id, path.join(root, p.id)]));
}
module.exports = { sources };
