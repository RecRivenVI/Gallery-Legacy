"use strict";
// Explicit platform policy, not a generic metadata traversal/schema.
const FIELDS = Object.freeze(Object.fromEntries([
  "pixiv", "pixivFANBOX", "Gank", "Fantia", "Patreon", "Pawchive", "X", "微博",
].map(id => [id, Object.freeze(["postUrl", "post_url", "url", "sourceUrl", "source_url", "permalink", "link", "source.url"])])));
function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    if ([...u.searchParams.keys()].some(k => /^(access_token|refresh_token|token|password|secret|cookie|authorization)$/i.test(k))) return null;
    return value;
  } catch { return null; }
}
function sourceLink(platformId, metadata) {
  for (const field of FIELDS[platformId] || []) {
    const value = field === "source.url" ? metadata.source?.url : metadata[field];
    const url = safeSourceUrl(value);
    if (url) return { role: "source_link", sourcePath: "$." + field, sourceFormat: "plain", sourceText: url };
  }
  return null;
}
module.exports = { sourceLink, safeSourceUrl };
