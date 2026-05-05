"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { normalizeRelativePath } = require("../library/paths.js");
const { inside, noLinks } = require("../library/io-paths.js");
const { createThumbnailCache } = require("./thumbnails.js");
const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};
function fail(code, status) {
  throw Object.assign(new Error(code), { code, status });
}
function stream(req, res, file, stat, type, headers = {}) {
  headers = { ...headers, "X-Content-Type-Options": "nosniff" };
  if (type === "image/svg+xml")
    headers["Content-Security-Policy"] =
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  const size = stat.size;
  if (size > BigInt(Number.MAX_SAFE_INTEGER))
    fail("MEDIA_SIZE_UNSUPPORTED", 422);
  let start = 0n,
    end = size - 1n,
    status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) fail("INVALID_RANGE", 416);
    if (!m[1]) {
      const n = BigInt(m[2]);
      if (n <= 0n) fail("INVALID_RANGE", 416);
      start = n >= size ? 0n : size - n;
    } else {
      start = BigInt(m[1]);
      end = m[2] ? BigInt(m[2]) : end;
    }
    if (start >= size || end < start) fail("INVALID_RANGE", 416);
    if (end >= size) end = size - 1n;
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": String(size === 0n ? 0n : end - start + 1n),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
    ...headers,
  });
  if (req.method === "HEAD" || size === 0n) return res.end();
  const input = fs.createReadStream(file, {
    start: Number(start),
    end: Number(end),
  });
  input.on("error", () => res.destroy());
  res.on("close", () => input.destroy());
  input.pipe(res);
}
function createMediaService(reader, config) {
  const cache = createThumbnailCache({
    root: config.instanceRoot,
    cacheRoot: config.cacheRoot,
    tempRoot: config.tempRoot,
  });
  function resolve(id) {
    const m = reader.media(id);
    if (!m) fail("MEDIA_NOT_FOUND", 404);
    const root = config.sources[m.platform_id];
    let target;
    try {
      target = path.resolve(
        root,
        normalizeRelativePath(m.work_relative_path).relativePath,
        normalizeRelativePath(m.relative_path).relativePath,
      );
      if (!inside(root, target)) fail("MEDIA_PATH_INVALID", 404);
      noLinks(target);
      const stat = fs.lstatSync(target, { bigint: true });
      if (!stat.isFile()) fail("MEDIA_NOT_FOUND", 404);
      return {
        candidateReal: target,
        stat,
        platformId: m.platform_id,
        work: { work_id: m.work_id },
        media: m,
      };
    } catch {
      fail("MEDIA_UNAVAILABLE", 404);
    }
  }
  return {
    async serve(req, res, id, thumbnail) {
      const file = resolve(id);
      if (thumbnail) {
        const cached = await cache.thumbnailFor(file);
        return stream(
          req,
          res,
          cached.path,
          fs.statSync(cached.path, { bigint: true }),
          "image/webp",
          { "X-Gallery-Thumbnail": cached.cacheStatus },
        );
      }
      return stream(
        req,
        res,
        file.candidateReal,
        file.stat,
        MIME[path.extname(file.candidateReal).toLowerCase()] ||
          "application/octet-stream",
      );
    },
    async close() {
      await cache.close?.();
    },
  };
}
module.exports = { createMediaService, stream };
