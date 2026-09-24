"use strict";
const { normalizeRelativePath } = require("./paths.js");
const { PLATFORM_REGISTRY } = require("./platforms.js");
// Old Venera favorites store this path, not a database integer. Keep it stable
// across generations, including the original unescaped directory components.
function publicPath(platformId, relativePath) {
  return "/p/" + encodeURIComponent(platformId) + "/" + normalizeRelativePath(relativePath).relativePath.replace(/\\/g, "/");
}
function parsePublicPath(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  const m = /^\/p\/([^/]+)\/(.+)$/.exec(value);
  if (!m) return null;
  try {
    const platformId = decodeURIComponent(m[1]);
    if (!PLATFORM_REGISTRY.some((p) => p.id === platformId)) return null;
    return { platformId, ...normalizeRelativePath(m[2]) };
  } catch { return null; }
}
module.exports = { publicPath, parsePublicPath };
