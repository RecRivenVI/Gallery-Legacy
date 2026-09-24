"use strict";
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
function scanPlatforms({ platformId = null, platformIds = null } = {}) {
  const fail = () => { throw Object.assign(new Error("Invalid platform selection"), { code: "SCAN_PLATFORM_INVALID" }); };
  if (platformIds !== null && platformId !== null) fail();
  const selected = platformIds !== null ? platformIds : platformId !== null ? [platformId] : null;
  if (selected === null) return null;
  if (!Array.isArray(selected) || !selected.length || selected.length > PLATFORM_REGISTRY.length || new Set(selected).size !== selected.length || selected.some(id => !PLATFORM_REGISTRY.some(p => p.id === id))) fail();
  return PLATFORM_REGISTRY.filter(p => selected.includes(p.id)).map(p => p.id);
}
module.exports = { scanPlatforms };
