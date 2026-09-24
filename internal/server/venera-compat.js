"use strict";
// The installed production ComicSource uses these read routes until it updates.
// Translate its physical path identity to current readers; never open an old DB.
const { parsePublicPath, publicPath } = require("../library/public-path.js");
const { bad } = require("./input.js");
function legacyWork(work) {
  const slash = work.stableId.lastIndexOf("/");
  return { name: work.stableId.slice(slash + 1), parentPath: work.stableId.slice(0, slash),
    displayName: work.title, subtitle: work.authorName, platform: work.platformId, kind: "dir",
    date: work.publishedAtMs === null ? null : new Date(work.publishedAtMs).toISOString(),
    cover: work.cover?.relativePath || null, coverType: work.cover?.type === "video" ? "vid" : "img",
    tags: work.tags.map((t) => t.label), badges: [work.flags.adult ? "adult" : null, work.flags.aiGenerated ? "ai" : null].filter(Boolean),
    description: work.description?.text || "", sourceUrl: work.sourceUrl || null, stableId: work.stableId };
}
function compatibility({ reader, page, fileBrowser, media }) {
  return async function handle(req, res, u) {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    const p = u.searchParams.get("p") || "";
    function send(data) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(data));
      return true;
    }
    if (["/api/media", "/api/thumbnail"].includes(u.pathname)) {
      if (p.startsWith("/f/")) {
        const parts = p.split("/");
        await media.serveResolved(req, res, fileBrowser.mediaFile(parts[2], parts.slice(3).join("/")), u.pathname === "/api/thumbnail");
      } else {
        const id = reader.mediaAtPublicPath(p);
        if (!id) bad("MEDIA_NOT_FOUND", 404);
        await media.serve(req, res, id, u.pathname === "/api/thumbnail");
      }
      return true;
    }
    if (u.pathname === "/api/db-entry") {
      const found = reader.resolvePublicPath(p);
      if (!found || found.kind !== "work") bad("WORK_NOT_FOUND", 404);
      return send({ item: legacyWork(found.item) });
    }
    if (u.pathname === "/api/list") {
      if (p.startsWith("/f/")) {
        const parts = p.split("/"), data = fileBrowser.list(parts[2], parts.slice(3).join("/"));
        return send({ items: data.media.map((m) => ({ name: m.name, kind: m.type === "video" ? "vid" : "img" })) });
      }
      const found = reader.resolvePublicPath(p);
      if (!found || found.kind !== "work") bad("WORK_NOT_FOUND", 404);
      return send({ items: found.item.media.filter((m) => m.defaultVisible !== false).map((m) => ({ name: m.relativePath, kind: m.type === "video" ? "vid" : "img" })) });
    }
    if (!["/api/db-authors", "/api/db-posts", "/api/db-author-posts", "/api/search"].includes(u.pathname)) return false;
    const rawPlatform = u.searchParams.get("platformPath") || p;
    const platform = u.searchParams.get("platform") || decodeURIComponent(rawPlatform.split("/")[2] || "");
    const parameters = new URLSearchParams({ platform, page: u.searchParams.get("page") || "1", pageSize: u.searchParams.get("pageSize") || "60" });
    if (u.searchParams.get("q")) parameters.set("q", u.searchParams.get("q"));
    const kind = u.pathname === "/api/db-authors" ? "authors" : "works";
    if (u.pathname === "/api/db-author-posts") {
      const legacyId = u.searchParams.get("authorId") || "";
      const resolved = reader.resolvePublicPath(legacyId.startsWith("/p/") ? legacyId : publicPath(platform, legacyId));
      if (!resolved || resolved.kind !== "author") bad("AUTHOR_NOT_FOUND", 404);
      parameters.set("author", resolved.item.id);
    }
    const result = page(kind, parameters);
    return send({ ...result, items: kind === "authors" ? result.items.map((a) => ({ authorId: parsePublicPath(a.stableId).relativePath, name: a.name, displayName: a.name })) : result.items.map(legacyWork) });
  };
}
module.exports = { compatibility };
