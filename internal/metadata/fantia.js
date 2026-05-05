"use strict";

const { addFieldSource, beginAdapt, finalize, richText, selectField, setIdentities, setPrimaryRichText, structuredSource } = require("./contract.js");
const { asId, asInteger, asObject, asText, fallback, httpUrl, normalizeTags, oneOrMany, parseTimestamp } = require("./helpers.js");

const PLATFORM_ID = "Fantia";
const VERSION = 2;

function classifyStructuredText(sourceText) {
  try {
    const parsed = JSON.parse(sourceText);
    return {
      encoding: "json_text",
      schemaHint: parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.ops) ? "quill_delta_like" : null,
    };
  } catch {
    return { encoding: "opaque_text", schemaHint: null };
  }
}

function adapt(context) {
  const { result, metadata } = beginAdapt(FantiaAdapter, context);
  if (!metadata) return finalize(result);
  const d = result.diagnostics;
  // content_id/file_id 在真实语料中同时存在 number/string；显式安全读取以记录漂移。
  asId(metadata.content_id, d, "content_id"); asId(metadata.file_id, d, "file_id");
  setIdentities(result, context, [{ path: "post_id", value: metadata.post_id }, { path: "content_id", value: metadata.content_id }], [{ path: "fanclub_user_id", value: metadata.fanclub_user_id }]);
  result.work.title = selectField(result, "work.title", [{ path: "post_title", value: metadata.post_title }, { path: "content_title", value: metadata.content_title }], asText);
  result.work.publishedAtMs = selectField(result, "work.publishedAtMs", [{ path: "posted_at", value: metadata.posted_at }, { path: "date", value: metadata.date }], parseTimestamp);
  result.authorProfile.displayName = selectField(result, "authorProfile.displayName", [{ path: "fanclub_user_name", value: metadata.fanclub_user_name }, { path: "fanclub_name", value: metadata.fanclub_name }], asText);
  result.authorProfile.handle = selectField(result, "authorProfile.handle", [{ path: "fanclub_name", value: metadata.fanclub_name }], asText);
  result.authorProfile.profileUrl = httpUrl(metadata.fanclub_url, d, "fanclub_url");
  const contentComment = asText(metadata.content_comment, d, "content_comment"); const blog = asText(metadata.blogpost_text, d, "blogpost_text"); const comment = asText(metadata.comment, d, "comment");
  if (blog) setPrimaryRichText(result, richText("blogpost_text", "plain", blog), 1);
  else if (comment) { setPrimaryRichText(result, richText("comment", "plain", comment), 2); fallback(d, "richText.primary", "comment"); }
  if (contentComment) {
    const classification = classifyStructuredText(contentComment);
    result.structuredSources.push(structuredSource("content_comment", classification.encoding, contentComment, "body_source", classification.schemaHint));
    addFieldSource(result, "structuredSources.contentComment", "metadata", "content_comment", 1);
  }
  if (comment && result.richText.primary?.sourcePath !== "comment") result.richText.supplementary.push(richText("comment", "plain", comment, "summary"));
  result.tags = normalizeTags(oneOrMany(metadata.tags, d, "tags").map((value, index) => asText(value, d, `tags[${index}]`)));
  const plan = asObject(metadata.plan, d, "plan"); const price = asInteger(plan?.price, d, "plan.price", { allowString: true }); result.work.flags.paid = price === null ? null : price > 0;
  const rating = asText(metadata.rating, d, "rating"); result.work.flags.adult = rating === null ? null : /adult|r-?18/i.test(rating);
  const fileName = asText(metadata.filename, d, "filename"); const fileUrl = httpUrl(metadata.file_url, d, "file_url");
  if (fileName !== null || fileUrl !== null) result.mediaDeclarations.push({ sourceId: asId(metadata.file_id, d, "file_id"), kind: asText(metadata.extension, d, "extension"), name: fileName, url: fileUrl, hash: null, size: null, durationMs: null });
  return finalize(result);
}

const FantiaAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = FantiaAdapter;
