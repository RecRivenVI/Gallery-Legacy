"use strict";
const crypto = require("node:crypto");
const protocol = require("../../protocol/protocol.json");
const { PLATFORM_REGISTRY } = require("../library/platforms.js");
function bad(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}
function int(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) bad("INVALID_NUMBER");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) bad("INVALID_NUMBER");
  return n;
}
function identifier(value) {
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) bad("INVALID_ID");
  const n = BigInt(value);
  if (n < 1n || n > 9223372036854775807n) bad("INVALID_ID");
  return n;
}
function query(params, kind, generation) {
  const allowed = new Set([
    "platform",
    "author",
    "tag",
    "q",
    "sort",
    "mediaType",
    "pageSize",
    "page",
    "cursor",
    "g",
  ]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      bad("INVALID_PARAMETER");
  const platform = params.get("platform");
  if (platform && !PLATFORM_REGISTRY.some((p) => p.id === platform))
    bad("INVALID_PLATFORM");
  const q = params.get("q") || "",
    tag = params.has("tag") ? params.get("tag") : null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q + (tag || "")))
    bad("INVALID_QUERY");
  if (
    kind !== "works" &&
    ["author", "tag", "mediaType"].some((key) => params.has(key))
  )
    bad("INVALID_PARAMETER");
  if (kind === "tags" && params.has("sort")) bad("INVALID_PARAMETER");
  if ([...q].length > 256 || (tag !== null && (!tag || tag.length > 512)))
    bad("QUERY_TOO_LONG");
  const sort =
    params.get("sort") || (kind === "authors" ? "name_asc" : "date_desc");
  if (
    !(kind === "authors" ? protocol.authorSorts : protocol.workSorts).includes(
      sort,
    )
  )
    bad("INVALID_SORT");
  const mediaType = params.get("mediaType") || "all";
  if (!protocol.mediaFilters.includes(mediaType)) bad("INVALID_MEDIA_FILTER");
  const pageSize = int(params.get("pageSize"), 48, 1, 200),
    page = int(params.get("page"), 1, 1, 1000000);
  const author = params.get("author");
  if (author) identifier(author);
  if (params.has("g") && params.get("g") !== generation)
    bad("GENERATION_CHANGED", 409);
  const result = {
    platformId: platform || null,
    authorId: author ? BigInt(author) : null,
    query: q,
    tag,
    sort,
    mediaType,
    limit: pageSize,
    page,
    pageSize,
  };
  const key = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        generation,
        platform,
        author,
        q,
        tag,
        sort,
        mediaType,
        pageSize,
      ]),
    )
    .digest("hex");
  if (params.has("cursor"))
    result.cursor = decodeCursor(params.get("cursor"), key, kind, sort);
  return { ...result, key };
}
function encodeCursor(position, key) {
  return position
    ? Buffer.from(
        JSON.stringify({ v: 1, key, position }, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).toString("base64url")
    : null;
}
function decodeCursor(value, key, kind, sort) {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    bad("INVALID_CURSOR");
  let data;
  try {
    data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    bad("INVALID_CURSOR");
  }
  if (!data || data.v !== 1 || data.key !== key) bad("CURSOR_CONTEXT_MISMATCH");
  const p = data.position;
  if (!p || typeof p !== "object") bad("INVALID_CURSOR");
  const field =
    kind === "authors" ? "authorId" : kind === "tags" ? "tagId" : "workId";
  const id = identifier(p[field]);
  if (kind === "tags") return { tagId: id };
  const numeric = /^(date|latest|posts)_/.test(sort);
  if (typeof p.value !== "string" || p.value.length > 20000)
    bad("INVALID_CURSOR");
  let v = p.value;
  if (numeric) {
    if (!/^-?\d{1,19}$/.test(v)) bad("INVALID_CURSOR");
    v = BigInt(v);
    if (v < -9223372036854775808n || v > 9223372036854775807n)
      bad("INVALID_CURSOR");
  }
  return { [field]: id, value: v };
}
module.exports = { bad, int, identifier, query, encodeCursor, decodeCursor };
