"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { noLinks } = require("../library/io-paths.js");
const { readJson, writeJson } = require("../instance/files.js");
const { normalizeRelativePath } = require("../library/paths.js");
function bad(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function createShortLinks(config, reader, fileBrowser) {
  const root = path.join(config.stateRoot, "short-links");
  noLinks(root); fs.mkdirSync(root, { recursive: true });
  const codes = new Set(fs.readdirSync(root).filter(n => /^[a-f0-9]{32}\.json$/.test(n)));
  function create(input) {
    if (!input || typeof input.path !== "string" || input.path.length > 3000 || /[\x00-\x1f\x7f]/.test(input.path)) bad("SHORT_LINK_INVALID");
    const selected = input.media === undefined || input.media === null ? null : normalizeMedia(input.media);
    if (input.path.startsWith("/p/")) {
      const found = reader.resolvePublicPath(input.path);
      if (found?.kind !== "work" || (selected && !found.item.media.some(m => m.relativePath === selected))) bad("SHORT_LINK_TARGET_MISSING", 404);
    } else if (input.path.startsWith("/f/")) {
      const [, , id, ...parts] = input.path.split("/");
      const rel = parts.join("/");
      if (selected) fileBrowser.mediaFile(id, [rel, selected].filter(Boolean).join("/"));
      else fileBrowser.list(id, rel, { pageSize: 1 });
    } else bad("SHORT_LINK_INVALID");
    const encoded = input.path.split("/").map(encodeURIComponent).join("/");
    const target = "/#" + encoded + (selected ? "?media=" + encodeURIComponent(selected) : "");
    const code = crypto.createHash("sha256").update(target).digest("hex").slice(0, 32);
    if (Object.hasOwn(config.shortLinks, code)) bad("SHORT_LINK_RESERVED", 409);
    const name = code + ".json", file = path.join(root, name); noLinks(file);
    if (!codes.has(name)) {
      if (codes.size >= 10000) bad("SHORT_LINK_LIMIT", 429);
      writeJson(file, { version: 1, target }); codes.add(name);
    } else if (readJson(file)?.target !== target) bad("SHORT_LINK_COLLISION", 409);
    return { code, url: "/s/" + code, target };
  }
  function resolve(code) {
    if (Object.hasOwn(config.shortLinks, code)) return config.shortLinks[code];
    if (!/^[a-f0-9]{32}$/.test(code)) return null;
    const file = path.join(root, code + ".json"); noLinks(file);
    const value = readJson(file);
    return value?.version === 1 && /^\/#\/(p|f)\//.test(value.target) && !/[\x00-\x1f\x7f]/.test(value.target) ? value.target : null;
  }
  return { create, resolve };
}
function normalizeMedia(value) {
  if (typeof value !== "string" || value.length > 3000) bad("SHORT_LINK_INVALID");
  try { return normalizeRelativePath(value).relativePath.replace(/\\/g, "/"); } catch { bad("SHORT_LINK_INVALID"); }
}
module.exports = { createShortLinks };
