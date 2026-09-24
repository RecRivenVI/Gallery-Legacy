"use strict";
const fs = require("node:fs"), path = require("node:path");
const { normalizeRelativePath } = require("./paths.js");
const { inside, noLinks } = require("./io-paths.js");
const { compareNatural } = require("../media/order.js");
const { SUPPORTED_IMAGE_EXTENSIONS, SUPPORTED_VIDEO_EXTENSIONS } = require("../media/eligibility-contract.js");
const image = new Set(SUPPORTED_IMAGE_EXTENSIONS), video = new Set(SUPPORTED_VIDEO_EXTENSIONS);
function bad(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function mediaType(name) { const ext = path.extname(name).slice(1).toLowerCase(); return image.has(ext) ? "image" : video.has(ext) ? "video" : null; }
function createFileBrowser(config) {
  function resolve(rootId, relative = "") {
    const root = config.fileBrowserRoots.find((r) => r.id === rootId);
    if (!root) bad("FILE_ROOT_NOT_FOUND", 404);
    if (typeof relative !== "string" || relative.length > 8192 || /[\x00-\x1f:]/.test(relative)) bad("FILE_PATH_INVALID");
    let rel;
    try { rel = relative ? normalizeRelativePath(relative).relativePath : ""; } catch { bad("FILE_PATH_INVALID"); }
    if (rel.split(/[\\/]/).some((s) => /[. ]$/.test(s))) bad("FILE_PATH_INVALID");
    const absolute = path.resolve(root.physicalRoot, rel);
    if (!inside(root.physicalRoot, absolute)) bad("FILE_PATH_INVALID");
    if (config.platforms.some(p => inside(p.physicalRoot, absolute))) bad("FILE_PLATFORM_EXCLUDED", 404);
    try {
      noLinks(absolute);
      const real = fs.realpathSync.native(absolute);
      if (!inside(root.physicalRoot, real)) bad("FILE_PATH_INVALID");
      if (config.platforms.some(p => inside(p.physicalRoot, real))) bad("FILE_PLATFORM_EXCLUDED", 404);
      return { root, relativePath: rel.replace(/\\/g, "/"), absolute: real, stat: fs.lstatSync(real, { bigint: true }) };
    } catch (e) { if (e.status) throw e; bad("FILE_UNAVAILABLE", 404); }
  }
  function url(kind, root, relativePath) { return "/api/v1/" + kind + "?" + new URLSearchParams({ root, path: relativePath }); }
  function fileDto(root, relativePath, name, stat) {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) bad("FILE_SIZE_UNSUPPORTED", 422);
    return { name, relativePath, type: mediaType(name), size: Number(stat.size),
      url: url("file-media", root, relativePath), thumbnailUrl: url("file-thumbnails", root, relativePath) };
  }
  function list(rootId, relative, { page = 1, pageSize = 100, filter = "all", order = "asc" } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500 || !["all", "image", "video"].includes(filter) || !["asc", "desc"].includes(order)) bad("FILE_QUERY_INVALID");
    const current = resolve(rootId, relative);
    if (!current.stat.isDirectory()) bad("FILE_DIRECTORY_REQUIRED", 404);
    const directories = [], media = [], diagnostics = [];
    let entries;
    try { entries = fs.readdirSync(current.absolute, { withFileTypes: true }); } catch { bad("FILE_DIRECTORY_UNREADABLE", 403); }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "$RECYCLE.BIN" || entry.name === "System Volume Information") continue;
      if (entry.isSymbolicLink()) { diagnostics.push({ code: "FILE_LINK_SKIPPED" }); continue; }
      const childPath = [current.relativePath, entry.name].filter(Boolean).join("/");
      try {
        const child = resolve(rootId, childPath);
        if (child.stat.isDirectory()) directories.push({ name: entry.name, type: "directory", relativePath: childPath });
        else if (child.stat.isFile() && mediaType(entry.name)) media.push(fileDto(rootId, childPath, entry.name, child.stat));
      } catch { diagnostics.push({ code: "FILE_ENTRY_UNAVAILABLE" }); }
    }
    const byName = (a, b) => compareNatural(a.name, b.name) * (order === "desc" ? -1 : 1);
    directories.sort(byName); media.sort(byName);
    const visibleMedia = media.filter((m) => filter === "all" || m.type === filter);
    const all = [...directories, ...visibleMedia];
    return { rootId, path: current.relativePath, items: all.slice((page - 1) * pageSize, page * pageSize),
      // The viewer fetches this directory's media only. No recursive retained tree.
      media: visibleMedia, total: all.length, totalDirectories: directories.length,
      totalImages: media.filter((m) => m.type === "image").length, totalVideos: media.filter((m) => m.type === "video").length,
      page, pageSize, totalPages: Math.max(1, Math.ceil(all.length / pageSize)), diagnostics };
  }
  function mediaFile(rootId, relative) {
    const current = resolve(rootId, relative), type = mediaType(current.absolute);
    if (!current.stat.isFile() || !type) bad("FILE_MEDIA_NOT_FOUND", 404);
    return { candidateReal: current.absolute, stat: current.stat, platformId: "file:" + rootId,
      work: { work_id: rootId }, media: { media_id: current.relativePath, relative_path_key: current.relativePath.toLowerCase(), filesystem_media_type: type } };
  }
  async function search(rootId, relative, { query, page = 1, pageSize = 48, filter = "all", order = "asc", signal, maxEntries = 50000, maxResults = 5000 } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 256 || /[\x00-\x1f]/.test(query)) bad("FILE_QUERY_INVALID");
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200 || !["all", "image", "video"].includes(filter) || !["asc", "desc"].includes(order)) bad("FILE_QUERY_INVALID");
    const start = resolve(rootId, relative); if (!start.stat.isDirectory()) bad("FILE_DIRECTORY_REQUIRED", 404);
    const term = query.normalize("NFKC").toLowerCase(), matches = [], diagnostics = [];
    let observed = 0, truncated = false;
    async function visit(rel, depth) {
      if (signal?.aborted) bad("REQUEST_CANCELLED", 499);
      if (depth > 64) { truncated = true; return; }
      let dir;
      try { dir = await fs.promises.opendir(resolve(rootId, rel).absolute); }
      catch (e) { if (e.code !== "FILE_PLATFORM_EXCLUDED") diagnostics.push({ code: "FILE_DIRECTORY_UNREADABLE" }); return; }
      for await (const entry of dir) {
        if (signal?.aborted) bad("REQUEST_CANCELLED", 499);
        if (++observed > maxEntries || matches.length >= maxResults) { truncated = true; break; }
        if (entry.name.startsWith(".") || ["$RECYCLE.BIN", "System Volume Information"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const child = [rel, entry.name].filter(Boolean).join("/");
        let found; try { found = resolve(rootId, child); } catch (e) { if (e.code !== "FILE_PLATFORM_EXCLUDED") diagnostics.push({ code: "FILE_ENTRY_UNAVAILABLE" }); continue; }
        const directory = found.stat.isDirectory(), type = mediaType(entry.name);
        if ((directory || (found.stat.isFile() && type && (filter === "all" || filter === type))) && child.normalize("NFKC").toLowerCase().includes(term))
          matches.push(directory ? { name: entry.name, relativePath: child, type: "directory" } : fileDto(rootId, child, entry.name, found.stat));
        if (directory) await visit(child, depth + 1);
        if (truncated && (observed > maxEntries || matches.length >= maxResults)) break;
      }
    }
    await visit(start.relativePath, 0);
    matches.sort((a,b) => compareNatural(a.relativePath,b.relativePath) * (order === "desc" ? -1 : 1));
    return { rootId, path: start.relativePath, items: matches.slice((page-1)*pageSize,page*pageSize), total: matches.length, page, pageSize, totalPages: Math.max(1,Math.ceil(matches.length/pageSize)), observed, truncated, complete: !truncated && !diagnostics.length, diagnostics: diagnostics.slice(0,100) };
  }
  return { roots: () => config.fileBrowserRoots.map((r) => ({ id: r.id, name: r.name })), list, mediaFile, search };
}
module.exports = { createFileBrowser };
